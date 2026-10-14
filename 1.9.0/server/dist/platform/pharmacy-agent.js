// Pharmacy PC side of the network. A pharmacy PC always serves the UI and API from its own encrypted copy of the
// database, so it keeps working when the main server or the network is down. In the background it:
//   - sends the work done here to the main server, in order (the outbox), so the hospital database stays complete;
//   - once the outbox is empty, pulls a fresh copy from the main server (central changes, other pharmacies);
//   - reports its state every ~15 s, and learns whether an admin has turned this PC off.
// Online vs offline only changes whether this syncing is flowing; the pharmacist's screens never stop.
import { scrubSafetyBody } from "../core/safety.js";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { certMac, isTlsFailure } from "./tls.js";
import { PIN_TRIES } from "../auth/limits.js";
import { writeFileSync, rmSync } from "node:fs";
import { db, adoptDatabase, keyFileFor } from "../db/index.js";
import { nowIso, now, toLocalIso, addDays } from "../lib/time.js";
import { nodeConfig, updateNodeConfig } from "./node-config.js";
import { appVersion, compareVersions } from "./version.js";
import { dataPath, dbFile } from "./paths.js";
import { saveKey } from "./keys.js";
import { applyRemoteLock, lockState, stageFromServer } from "./updater.js";
import { reserveOfflineIds, offlineCounters, rewriteOfflineIds } from "./ids.js";
import { OFFLINE_ID_BASE } from "../db/versioned.js";
import { confirmFromServer } from "./licence.js";
/**
 * Writes whose body holds a password: your own password change, and an admin's new user or password reset (user
 * changes made on a pharmacy PC are refused by the main server, so they end up as rejected work, shown to admins).
 */
export const carriesPassword = (url) => /^\/api\/(auth\/password|admin\/users)(\/|[?#]|$)/.test(url);
/**
 * One request to the main server. Throws { status, error } on an error reply, or a network error. Once this PC holds
 * the main server's certificate (node.json serverCert, from a heartbeat) it talks to it over TLS and trusts only that
 * certificate (platform/tls.ts) — whatever address it has, since the certificate itself is what is checked.
 */
export async function hubFetch(serverUrl, path, o) {
    const pinned = o.plain ? undefined : nodeConfig().serverCert;
    const url = (o.plain ? serverUrl.replace(/^https:/i, "http:") : pinned ? serverUrl.replace(/^http:/i, "https:") : serverUrl).replace(/\/+$/, "") + path;
    const headers = { ...(o.body ? { "content-type": "application/json" } : {}), ...(o.token ? { "x-node-token": o.token } : {}) };
    const body = o.body ? JSON.stringify(o.body) : undefined;
    let status, buf;
    if (pinned && url.startsWith("https:"))
        ({ status, buf } = await pinnedRequest(url, o.method, headers, body, pinned, o.timeoutMs ?? 15000));
    else {
        const c = new AbortController();
        const timer = setTimeout(() => c.abort(), o.timeoutMs ?? 15000);
        try {
            const r = await fetch(url, { method: o.method, signal: c.signal, headers, body });
            status = r.status;
            buf = Buffer.from(await r.arrayBuffer());
        }
        finally {
            clearTimeout(timer);
        }
    }
    const ok = status >= 200 && status < 300;
    if (o.raw) {
        if (!ok)
            throw Object.assign(new Error(`server returned ${status}`), { status });
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    const text = buf.toString("utf8");
    const data = text ? JSON.parse(text) : {};
    if (!ok)
        throw Object.assign(new Error(data.error ?? `server returned ${status}`), { status, data });
    return data;
}
/** An HTTPS request that accepts only the given certificate (the main server's own, self-signed). */
function pinnedRequest(url, method, headers, body, cert, timeoutMs) {
    return new Promise((resolve, reject) => {
        const q = httpsRequest(url, { method, headers, ca: cert, checkServerIdentity: () => undefined, timeout: timeoutMs }, (res) => {
            const parts = [];
            res.on("data", (c) => parts.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(parts) }));
            res.on("error", reject);
        });
        q.on("timeout", () => q.destroy(new Error("The main server did not answer in time")));
        q.on("error", reject);
        if (body)
            q.write(body);
        q.end();
    });
}
/** The exit code that makes the launcher swap in a staged update and relaunch (update-routes RESTART_EXIT_CODE). */
const RESTART_EXIT_CODE = 69;
/** Update automatically only after this long with no work done here, so a restart never lands mid-dispense. */
const UPDATE_IDLE_MS = 5 * 60_000;
const UPDATE_RETRY_MS = 30 * 60_000;
let lastWriteAt = Date.now(); // wait a while after start-up too
class PharmacyAgent {
    online = false;
    disabled = false;
    lastContactAt = null;
    lastSyncAt = null;
    offlineSince = nowIso();
    serverVersion = null;
    serverTimeSkewMs = null;
    syncing = false;
    updateError = null;
    problem = null;
    updateTriedAt = 0;
    updating = false;
    timer = null;
    stopped = false;
    start() {
        if (this.timer)
            return;
        const tick = async () => {
            if (this.stopped)
                return;
            try {
                await this.syncNow();
            }
            catch { /* reported via state */ }
            if (!this.stopped)
                this.timer = setTimeout(tick, this.online ? 15000 : 8000);
        };
        this.timer = setTimeout(tick, 1500);
    }
    stop() { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); this.timer = null; }
    status() {
        const pendingOps = this.count("SELECT COUNT(*) c FROM outbox");
        const failedOps = this.count("SELECT COUNT(*) c FROM sync_failures");
        return { online: this.online, disabled: this.disabled, lastContactAt: this.lastContactAt, lastSyncAt: this.lastSyncAt,
            pendingOps, failedOps, offlineSince: this.online ? null : this.offlineSince,
            serverVersion: this.serverVersion, updateAvailable: !!this.serverVersion && compareVersions(this.serverVersion, appVersion()) > 0,
            serverTimeSkewMs: this.serverTimeSkewMs, syncing: this.syncing, updateError: this.updateError, problem: this.problem };
    }
    count(sql) { try {
        return db().get(sql)?.c ?? 0;
    }
    catch {
        return 0;
    } }
    /** One full exchange with the main server: push the outbox, then (if clear) pull a fresh copy. */
    async syncNow() {
        const c = nodeConfig();
        if (c.role !== "pharmacy" || !c.serverUrl || !c.nodeToken)
            return this.status();
        if (this.syncing)
            return this.status();
        this.syncing = true;
        try {
            const getState = () => hubFetch(c.serverUrl, "/api/sync/state", { method: "GET", token: c.nodeToken, timeoutMs: 8000 });
            const state = await getState().catch(async (e) => { await this.recoverCert(c.serverUrl, c.nodeToken, e); return getState(); });
            this.markOnline(state);
            if (this.disabled)
                return this.status(); // turned off by an admin: do not sync, the UI shows why
            await this.pushOutbox(c.serverUrl, c.nodeToken);
            if (this.count("SELECT COUNT(*) c FROM outbox") === 0)
                await this.maybePullSnapshot(c.serverUrl, c.nodeToken, state);
            await this.heartbeat(c.serverUrl, c.nodeToken);
            this.problem = null;
            if (this.autoUpdateDue())
                void this.updateFromServer(true).catch(() => { });
        }
        catch (e) {
            if (e?.status === 403 && e?.data?.details?.code === "node_disabled") {
                this.markOnline({ status: "disabled" });
            }
            // The main server is turned off (the owner's off switch): it answers every sync call with 423, so this is how
            // the lock reaches this PC (the heartbeat that would carry it cannot get through).
            else if (e?.status === 423 && e?.data?.code === "locked") {
                this.markOnline({});
                // The server's own licence message speaks of "this computer" and its code: say which computer it means.
                applyRemoteLock(true, e.data.reason === "unlicensed"
                    ? "The main server has no licence, so the system is paused. An admin must install the main server's licence on the main server."
                    : e.data.error ?? null);
            }
            // Still applying this PC's previous push (it gave up waiting for the answer): reachable, try again next round.
            else if (e?.status === 503 && this.online) { /* stays online */ }
            else {
                this.markOffline();
                // The main server answered but refused (this PC removed there, the address now points at another PC…): say why,
                // or the pill would only ever say Offline.
                this.problem = typeof e?.status === "number" ? String(e.message ?? `The main server answered ${e.status}`) : null;
            }
        }
        finally {
            this.syncing = false;
        }
        return this.status();
    }
    /**
     * Pharmacy PCs follow the main server's version: when it runs a newer one, this PC updates itself from it (no
     * internet needed) once nothing has been done here for a while and all work is sent. Only when run by the launcher,
     * which swaps the files in and relaunches.
     */
    autoUpdateDue() {
        if (process.env.HPS_LAUNCHER !== "1" || this.updating || !this.status().updateAvailable)
            return false;
        if (Date.now() - this.updateTriedAt < UPDATE_RETRY_MS || Date.now() - lastWriteAt < UPDATE_IDLE_MS)
            return false;
        return this.count("SELECT COUNT(*) c FROM outbox") === 0 && !(lockState().locked && lockState().reason !== "too_old");
    }
    /**
     * Download the main server's version from it, check the owner's signature and every file, stage it and restart
     * into it. Also run by an admin from Admin → Updates on this PC.
     */
    async updateFromServer(auto = false) {
        const c = nodeConfig();
        if (c.role !== "pharmacy" || !c.serverUrl || !c.nodeToken)
            throw new Error("This PC is not connected to a main server");
        if (this.updating)
            throw new Error("An update is already being downloaded");
        this.updating = true;
        this.updateTriedAt = Date.now();
        try {
            const rel = await hubFetch(c.serverUrl, "/api/sync/release", { method: "GET", token: c.nodeToken, timeoutMs: 60000 });
            const r = await stageFromServer(String(rel.version), String(rel.manifest), String(rel.sig), async (path) => Buffer.from(await hubFetch(c.serverUrl, `/api/sync/release/file?path=${encodeURIComponent(path)}`, { method: "GET", raw: true, token: c.nodeToken, timeoutMs: 120000 })));
            this.updateError = null;
            if (auto)
                db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", // an admin's install is audited by the route
                [nowIso(), "system.update.apply", "system", JSON.stringify({ from: appVersion(), to: rel.version, files: r.files, source: "main server", auto: true })]);
            setTimeout(() => process.exit(RESTART_EXIT_CODE), 400);
            return { version: String(rel.version), files: r.files };
        }
        catch (e) {
            this.updateError = String(e?.message ?? e);
            throw e;
        }
        finally {
            this.updating = false;
        }
    }
    markOnline(state) {
        this.online = true;
        this.disabled = state?.status === "disabled"; // re-enabled by an admin: syncs again
        this.lastContactAt = nowIso();
        this.offlineSince = null;
        if (state?.version)
            this.serverVersion = state.version;
        if (typeof state?.serverTime === "number")
            this.serverTimeSkewMs = state.serverTime - Date.now();
    }
    markOffline() { if (this.online)
        this.offlineSince = nowIso(); this.online = false; }
    /** Send queued work to the main server in order; drop ops the server accepts or permanently rejects. */
    async pushOutbox(serverUrl, token) {
        for (;;) {
            const ops = db().all("SELECT seq, op_id AS opId, at, user_id AS userId, location_id AS locationId, method, url, body, created, uuids, outcome FROM outbox ORDER BY seq LIMIT 100");
            if (!ops.length)
                break;
            let res;
            try {
                // A long wait: a hundred ops (a whole-ward run among them) can take a while to apply, and giving up early only
                // makes this PC send the same work again while the first copy is still being applied.
                res = await hubFetch(serverUrl, "/api/sync/replay", { method: "POST", token, timeoutMs: 180_000,
                    body: { ops: ops.map((o) => ({ opId: o.opId, at: o.at, userId: o.userId ?? 0, locationId: o.locationId ?? null, method: o.method, url: o.url,
                            body: o.body ?? null, created: o.created ? JSON.parse(o.created) : null, uuids: o.uuids ? JSON.parse(o.uuids) : null,
                            outcome: o.outcome ? JSON.parse(o.outcome) : null })) } });
            }
            catch (e) {
                db().run("UPDATE outbox SET tries = tries + 1 WHERE seq <= ?", [ops[ops.length - 1].seq]);
                throw e;
            }
            let serverError = null;
            db().tx(() => {
                for (const r of res.results) {
                    const op = ops.find((o) => o.opId === r.opId);
                    if (!op)
                        continue;
                    if (r.status >= 500) {
                        serverError = r;
                        break;
                    } // retried later, in order
                    db().run("DELETE FROM outbox WHERE op_id = ?", [r.opId]); // applied, or will never apply
                    for (const [local, main] of r.ids ?? []) // in use after the next copy
                        db().run("INSERT OR REPLACE INTO id_aliases(local_id, main_id, active, at) VALUES (?,?,0,?)", [local, main, nowIso()]);
                    // Permanently rejected, or applied but not as it was here (less dispensed): keep for the admin/pharmacist.
                    if (r.status >= 400 || r.warning) {
                        let error = r.warning ?? null;
                        if (!error)
                            try {
                                error = JSON.parse(r.body)?.error ?? null;
                            }
                            catch { /* keep null */ }
                        // A password change, a new user or a password reset carries a password in its body: never keep or report it.
                        const body = carriesPassword(op.url) ? null : op.body;
                        db().run(`INSERT OR REPLACE INTO sync_failures(op_id, at, user_id, method, url, body, status, error, reported, failed_at)
                      VALUES (?,?,?,?,?,?,?,?,0,?)`, [op.opId, op.at, op.userId, op.method, op.url, body, r.status, error, nowIso()]);
                    }
                }
            });
            // The main server could not apply one op right now: stop here (the rest waits behind it) and try again next round.
            if (serverError) {
                const se = serverError;
                db().run("UPDATE outbox SET tries = tries + 1, last_error = ? WHERE op_id = ?", [se.body.slice(0, 500), se.opId]);
                return;
            }
            if (res.results.length < ops.length)
                break;
        }
    }
    /** Replace the local copy with a fresh one from the main server (keeping this PC's sign-ins). */
    async maybePullSnapshot(serverUrl, token, state) {
        const have = db().get("SELECT value FROM schema_meta WHERE key = 'snapshot_revision'")?.value;
        const want = `${state.bootId}:${state.revision}`;
        if (have === want) {
            this.lastSyncAt = nowIso();
            return;
        }
        const buf = await hubFetch(serverUrl, "/api/sync/snapshot", { method: "GET", raw: true, token, timeoutMs: 120000 });
        // Work done here while the copy was downloading is not in it: swapping now would lose that work (and its outbox
        // entry) for good. Leave the swap for the next round, after that work has been sent. From this check to the swap
        // nothing awaits, so no request can slip in between.
        if (this.count("SELECT COUNT(*) c FROM outbox") > 0)
            return;
        const sessions = db().all("SELECT token, user_id, location_id, created_at, expires_at, locked_at, last_seen_at FROM sessions WHERE expires_at > ?", [nowIso()]);
        // wrong PINs and codes counted here (the copy does not have them): a fresh copy must not reset the count
        const authState = db().all("SELECT id, pin_failures, totp_failures, totp_locked_until, pin_hash IS NULL AS pin_off FROM users WHERE pin_failures > 0 OR totp_failures > 0 OR totp_locked_until IS NOT NULL");
        const failures = db().all("SELECT * FROM sync_failures");
        const nodeId = nodeConfig().nodeId;
        const counters = nodeId ? offlineCounters(db(), nodeId) : {};
        // The new copy has the main server's rows (and their ids) for work made here; a screen opened before still uses the
        // ids made here for a while (an open walk-in ticket): keep answering to them for a week.
        const aliases = db().all("SELECT local_id, main_id, at FROM id_aliases WHERE at > ?", [toLocalIso(addDays(now(), -7))]);
        const tmp = dataPath(`snapshot-${randomUUID()}.tmp`);
        writeFileSync(tmp, Buffer.from(buf));
        // The copy is encrypted with this PC's sync key, which is also this PC's database key.
        const key = db().key ?? nodeConfig().syncKey;
        if (!key)
            throw new Error("This PC has no database key for the main server's copy; connect it again");
        try {
            adoptDatabase(tmp, key, (hex) => saveKey(keyFileFor(dbFile()), hex));
        }
        finally {
            rmSync(tmp, { force: true });
        }
        // Ids made here are never handed out again: the main server may still know them as rows it created for this PC.
        if (nodeId)
            reserveOfflineIds(db(), nodeId, counters);
        // Keep the pharmacist signed in and keep the record of rejected offline work across the swap.
        db().tx(() => {
            // (Not for a user or pharmacy the main server has removed meanwhile: that would break the whole swap.)
            // (and a locked screen stays locked)
            for (const s of sessions)
                db().run(`INSERT OR IGNORE INTO sessions(token, user_id, location_id, created_at, expires_at, locked_at, last_seen_at)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) AND EXISTS (SELECT 1 FROM locations WHERE id = ?)`, [s.token, s.user_id, s.location_id, s.created_at, s.expires_at, s.locked_at, s.last_seen_at, s.user_id, s.location_id]);
            for (const u of authState) {
                db().run(`UPDATE users SET pin_failures = MAX(pin_failures, ?), totp_failures = MAX(totp_failures, ?), totp_locked_until = COALESCE(?, totp_locked_until) WHERE id = ?`, [u.pin_failures, u.totp_failures, u.totp_locked_until, u.id]);
                if (u.pin_failures >= PIN_TRIES)
                    db().run("UPDATE users SET pin_hash = NULL WHERE id = ?", [u.id]);
            }
            for (const f of failures)
                db().run(`INSERT OR IGNORE INTO sync_failures(op_id, at, user_id, method, url, body, status, error, reported, failed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [f.op_id, f.at, f.user_id, f.method, f.url, f.body, f.status, f.error, f.reported, f.failed_at]);
            for (const a of aliases)
                db().run("INSERT OR REPLACE INTO id_aliases(local_id, main_id, active, at) VALUES (?,?,1,?)", [a.local_id, a.main_id, a.at]);
            db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('snapshot_revision', ?)", [want]);
        });
        this.lastSyncAt = nowIso();
    }
    /**
     * The pinned certificate no longer matches (the main server made a new one, e.g. after a reinstall from backup): ask
     * over plain HTTP, saying nothing but counts, and take a new certificate only if it comes vouched for with this PC's
     * sync key; nothing else from that answer is trusted. Throws (with a clear message) when there is none to take.
     */
    async recoverCert(serverUrl, token, e) {
        if (!nodeConfig().serverCert || !isTlsFailure(e))
            throw e;
        const r = await hubFetch(serverUrl, "/api/sync/heartbeat", { method: "POST", token, plain: true, timeoutMs: 8000, body: {
                version: appVersion(), pendingOps: 0, failedOps: 0, offlineSince: this.offlineSince, lastSyncAt: null
            } });
        if (!this.takeCert(serverUrl, r))
            throw Object.assign(new Error("The main server's certificate does not match the one this PC trusts. Set this PC up again (Setup) to trust the new one."), { status: 495 });
    }
    /** The main server's certificate from a heartbeat answer, when it is new and vouched for with this PC's sync key. */
    takeCert(serverUrl, r) {
        if (typeof r?.tlsCert !== "string" || !r.tlsCert.includes("BEGIN CERTIFICATE") || r.tlsCert === nodeConfig().serverCert
            || !db().key || typeof r.tlsMac !== "string" || r.tlsMac !== certMac(db().key, r.tlsCert))
            return false;
        updateNodeConfig({ serverCert: r.tlsCert, serverUrl: serverUrl.replace(/^http:/i, "https:") });
        return true;
    }
    async heartbeat(serverUrl, token) {
        const issues = db().all("SELECT op_id AS opId, at, user_id AS userId, method, url, body, status, error FROM sync_failures WHERE reported = 0 LIMIT 200");
        const r = await hubFetch(serverUrl, "/api/sync/heartbeat", { method: "POST", token, body: {
                version: appVersion(), pendingOps: this.count("SELECT COUNT(*) c FROM outbox"), failedOps: this.count("SELECT COUNT(*) c FROM sync_failures"),
                offlineSince: this.offlineSince, lastSyncAt: this.lastSyncAt, issues,
                failures: db().all("SELECT op_id FROM sync_failures WHERE reported = 1 ORDER BY failed_at LIMIT 2000").map((f) => f.op_id),
                chatSeen: db().get("SELECT last_seen AS s FROM chat_presence WHERE location_id = ?", [nodeConfig().locationId ?? -1])?.s ?? null,
            } });
        if (issues.length)
            db().run(`UPDATE sync_failures SET reported = 1 WHERE op_id IN (${issues.map(() => "?").join(",")})`, issues.map((i) => i.opId));
        // Resolved by an admin on the main server: no longer this PC's problem (otherwise "failed" would show here forever).
        if (Array.isArray(r?.resolved))
            db().tx(() => { for (const opId of r.resolved)
                db().run("DELETE FROM sync_failures WHERE op_id = ?", [String(opId)]); });
        if (r?.serverVersion)
            this.serverVersion = r.serverVersion;
        if (typeof r?.killed === "boolean")
            applyRemoteLock(r.killed, r.lockMessage ?? null);
        if (r?.licence?.ok)
            confirmFromServer(r.licence.offlineDays);
        // The main server's certificate: from now on this PC talks to it over TLS, trusting only it. A new one (the main
        // server made another) comes over the link already pinned, or over the first, already authenticated, exchange.
        this.takeCert(serverUrl, r);
    }
}
let singleton = null;
export function agent() { return (singleton ??= new PharmacyAgent()); }
/**
 * Pharmacy PC: an id made here for a row the main server has since given its own id (and this PC's copy now has under
 * that id) is read as the main server's id — in the address and the body of each request — so a screen opened before
 * the copy was refreshed (a walk-in ticket being filled in) keeps working.
 */
export function aliasOfflineIds(text) {
    const nodeId = nodeConfig().nodeId;
    if (nodeConfig().role !== "pharmacy" || !nodeId)
        return text;
    return rewriteOfflineIds(text, nodeId, (id) => db().get("SELECT main_id FROM id_aliases WHERE local_id = ? AND active = 1", [id])?.main_id);
}
/**
 * Whether a write to `url` is queued for the main server. Sign-ins stay on this PC, but a password change is replayed:
 * the next copy from the main server would otherwise bring the old password (and "must change password") back.
 * Chat presence (every few seconds per open screen) is not queued: replaying it would only keep the outbox from ever
 * emptying, which holds back every fresh copy from the main server; the sync heartbeat carries it instead. (Read marks
 * are sent only when new messages are read, and are replayed: the next copy would otherwise make them unread.)
 */
export function queuedWrite(url, method) {
    return /^(POST|PUT|PATCH|DELETE)$/.test(method) && url.startsWith("/api/")
        && !/^\/api\/(local|system|sync|network|update|licence)\b/.test(url) && !/^\/api\/auth\/(?!password(?:[?#]|$))/.test(url)
        && !/^\/api\/chat\/heartbeat(?:[/?#]|$)/.test(url);
}
// Admin changes made here are refused by the main server (they are recorded only so they show as rejected work):
// their bodies, new users' passwords among them, need not be kept or sent.
// (a second pharmacist's password, given for a high-alert medicine, is never kept: core/safety.ts scrubSafetyBody)
const queuedBody = (url, body) => (/^\/api\/admin\//.test(url) ? null : body == null ? null : scrubSafetyBody(body));
// The rows a write created here, with this PC's ids: the main server matches them to the rows it creates for the same
// work, so later work that uses them (lines of a new walk-in ticket, dispensing a new order) replays too.
const ownRows = (created) => { const own = created.filter(([, rowId]) => rowId >= OFFLINE_ID_BASE); return own.length ? JSON.stringify(own) : null; };
const json = (v) => (v?.length ? JSON.stringify(v) : null);
/**
 * Inside the transaction that commits a queued write's work (the database write observer, platform/hub.ts): its
 * outbox row commits with it. Queued only once the answer was sent, work done here could be committed and then never
 * reach the main server — this PC stopping in between (a power cut, the app closed) — and the next copy from the main
 * server would then remove it from here as well. A later transaction of the same write brings the row up to date.
 */
export function queueAtCommit(d, w, created, uuids) {
    if (w.queued) {
        d.run("UPDATE outbox SET created = ?, uuids = ? WHERE op_id = ?", [ownRows(created), json(uuids), w.opId]);
        return;
    }
    const r = w.request(), at = nowIso();
    d.run("INSERT OR IGNORE INTO outbox(op_id, at, user_id, location_id, method, url, body, created_at, created, uuids) VALUES (?,?,?,?,?,?,?,?,?,?)", [w.opId, at, r.ctx?.userId ?? null, r.ctx?.locationId ?? null, r.method, r.url, queuedBody(r.url, r.body), at, ownRows(created), json(uuids)]);
}
/**
 * onSend hook (pharmacy role): record each successful business write so it can be replayed on the main server. A write
 * whose work committed is queued already (queueAtCommit): its row gets what is known only now (what it dispensed). It
 * stays queued whatever the answer: its work is in this PC's copy, so the main server must have it too (or say why not).
 */
export function recordWrites(url, method, status, body, opId, ctx, at, created = [], more = {}) {
    if (!queuedWrite(url, method))
        return;
    if (more.queued)
        lastWriteAt = Date.now();
    if (status < 200 || status >= 300)
        return;
    lastWriteAt = Date.now();
    const id = opId ?? randomUUID();
    try {
        // Also the run ids made here (the main server gives its runs the same ones) and what was dispensed here (compared
        // with what the main server can dispense). (A queued row already sent and applied is gone: nothing to add then.)
        if (more.queued)
            db().run("UPDATE outbox SET created = ?, uuids = ?, outcome = ? WHERE op_id = ?", [ownRows(created), json(more.uuids), more.outcome ? JSON.stringify(more.outcome) : null, id]);
        else
            db().run("INSERT OR IGNORE INTO outbox(op_id, at, user_id, location_id, method, url, body, created_at, created, uuids, outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [id, at, ctx?.userId ?? null, ctx?.locationId ?? null, method, url, queuedBody(url, body), nowIso(), ownRows(created),
                json(more.uuids), more.outcome ? JSON.stringify(more.outcome) : null]);
    }
    catch { /* outbox best-effort; the write already succeeded locally */ }
}
