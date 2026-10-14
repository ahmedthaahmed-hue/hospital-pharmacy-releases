// Main-server side of the hospital network.
//   /api/system/*   public: what this PC is (the setup screen and pharmacy PCs ask), first-run setup
//   /api/sync/*     pharmacy PCs (x-node-token): register, database copies, replay of offline work, heartbeat
//   /api/network/*  admins: registered PCs, sync problems, recovery key, restore a database
// Every write that carries an operation id (x-op-id) is recorded in applied_ops, so a request repeated after a network
// failure (or replayed after working offline) returns its first answer instead of running twice.
import { tlsInfo } from "./tls-state.js";
import { totpRequiredFor, useSecondFactor } from "../auth/routes.js";
import { certMac } from "./tls.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, rmSync, writeFileSync, statSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { z } from "zod";
import { db, encryptInPlace, replaceDb, setWriteObserver, Db } from "../db/index.js";
import { HttpError, parse, audit, requireOwner, requirePerm } from "../lib/http.js";
import { accessOf } from "../auth/access.js";
import { nowIso, parseLocal, toLocalIso } from "../lib/time.js";
import { verifyPassword, checkUserPassword } from "../auth/passwords.js";
import { throttledCheck } from "../lib/rate-limit.js";
import { keyPragma, formatRecoveryKey, parseRecoveryKey } from "./keys.js";
import { nodeConfig } from "./node-config.js";
import { appVersion } from "./version.js";
import { dataPath } from "./paths.js";
import { currentScope, withScope } from "./clock.js";
import { isOfflineId, rewriteOfflineIds } from "./ids.js";
import { outcomeOf, outcomeDifference } from "./outcome.js";
import { lockState, ensureReleaseCached, cachedReleaseFile } from "./updater.js";
import { licenceStatus, pharmacyPcLimit } from "./licence.js";
import { carriesPassword, queueAtCommit } from "./pharmacy-agent.js";
import { randomUUID } from "node:crypto";
/** Secret for requests the server sends itself (replay through app.inject); it never leaves this process. */
const INTERNAL = randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** The real time, for bookkeeping that must not take a replayed op's time (pruning counts from it). */
const realNowIso = () => toLocalIso(new Date());
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** What a pharmacy PC's replayed work may never reach (checked on the URL text and on the route that matched it). */
const REPLAY_FORBIDDEN = /^\/api\/(sync|system|network|admin|update|local|licence)(\/|$)/;
/** True for a request this server sent itself (a replay through app.inject). */
function isInternal(req) {
    const h = req.headers["x-hps-internal"];
    return typeof h === "string" && h.length === INTERNAL.length && timingSafeEqual(Buffer.from(h), Buffer.from(INTERNAL));
}
/**
 * Context for a replayed request: the pharmacist who did the work. (The time they did it is set by the replay itself,
 * see withScope in /api/sync/replay.)
 */
export function internalCtx(req) {
    if (!isInternal(req))
        return null;
    // Decide by the route that matched, not by the URL text: "/api/%61dmin/users" or "/api/./admin/users" reach the
    // admin routes too, and a pharmacy PC must never act as an admin on the main server.
    if (REPLAY_FORBIDDEN.test(req.routeOptions?.url ?? ""))
        throw new HttpError(403, "Not allowed from a pharmacy PC");
    const u = db().get("SELECT id, username, display_name, role, role_id, active, location_id FROM users WHERE id = ?", [Number(req.headers["x-hps-user"])]);
    if (!u || !u.active)
        throw new HttpError(403, "The user who did this work no longer exists or is disabled");
    const locationId = Number(req.headers["x-hps-location"]);
    // The same rule as signing in and switching pharmacy: a user pinned to one pharmacy can only have worked as it, so a
    // PC can only replay work as admins or as users of its own pharmacy (not as anyone in the hospital).
    const access = accessOf(u);
    if (!access.perms.has("pharmacies.all") && u.location_id != null && u.location_id !== locationId)
        throw new HttpError(403, "This user does not work at this PC's pharmacy");
    // Work replayed as an admin keeps to the PC's pharmacy too. The PC names the user itself, so an admin's role here would
    // let any PC change another pharmacy's stock or runs (routes let admins pass another pharmacy's id); admin-only routes
    // are refused above anyway.
    // The same for permissions: the daily work of the user's role, without administration or other pharmacies — and
    // never more than whoever connected this PC may do (an admin who manages PCs could otherwise send work under anyone's
    // name). Work in the owner's name only from a PC the owner connected.
    const node = db().get("SELECT registered_by FROM nodes WHERE id = ?", [Number(req.headers["x-hps-node"])]);
    const by = node?.registered_by != null ? db().get("SELECT id, role, role_id, active FROM users WHERE id = ?", [node.registered_by]) : null;
    const registrant = by ? accessOf(by) : null;
    if (access.owner && registrant && !registrant.owner)
        throw new HttpError(403, "Work in the owner's name is accepted only from a PC the owner connected");
    const role = u.role === "admin" ? "pharmacist" : u.role;
    const perms = new Set([...access.perms].filter((p) => !p.startsWith("admin.") && p !== "pharmacies.all" && p !== "layouts.shared"
        && (!registrant || registrant.perms.has(p))));
    return { userId: u.id, username: u.username, displayName: u.display_name, role, locationId, token: "replay",
        roleId: access.roleId, roleName: access.roleName, owner: false, perms };
}
/** Bookkeeping tables: rows written there are not part of the work itself. */
const BOOKKEEPING = new Set(["applied_ops", "replay_ids", "outbox", "sync_failures", "sync_issues", "sessions"]);
/** applied_ops.status of an op whose work was committed but whose answer was never recorded (the server stopped). */
const PENDING = 0;
/** The answer to an op sent again whose work was applied but whose first answer was never recorded. */
const LOST_ANSWER = JSON.stringify({ applied: true, answerLost: true });
const PARTIAL_ERROR = JSON.stringify({ error: "The main server stopped partway through this work — check what was saved before entering it again" });
/**
 * Repeat protection and id mapping see every write of a replayed op (request scope, platform/clock.ts):
 * - the op's applied_ops record is written inside the same transaction as the op's work, so the work and the record
 *   commit together — a crash can never leave work applied without its record (and so applied twice when repeated);
 * - the rows the op inserts are collected, to map the ids the pharmacy PC gave them to the ids given here.
 */
setWriteObserver({
    wantsTx: () => { const s = currentScope(); return (!!s?.op && !s.op.closed) || (!!s?.pcWrite && !s.pcWrite.closed); },
    inserted: (table, firstId, count) => {
        const s = currentScope();
        if (!s?.created || BOOKKEEPING.has(table))
            return;
        for (let i = 0; i < count && s.created.length < MAX_CREATED; i++)
            s.created.push([table, firstId + i]);
    },
    beforeCommit: (d) => {
        committing = null;
        committingPc = null;
        const s = currentScope(), op = s?.op;
        // Pharmacy PC: the write's outbox row commits with its work (pharmacy-agent.ts queueAtCommit).
        if (s?.pcWrite && !s.pcWrite.closed) {
            queueAtCommit(d, s.pcWrite, s.created ?? [], s.uuids);
            committingPc = s.pcWrite;
        }
        if (!op || op.closed)
            return;
        // The rows the op made so far go into its record too: if the server stops before the answer is recorded, the op sent
        // again still learns which rows here are the ones the PC made (opDedupHooks), so later work that uses them maps.
        const pending = JSON.stringify({ pendingCreated: s.created ?? [] });
        if (op.recorded) {
            d.run("UPDATE applied_ops SET response = ? WHERE op_id = ? AND status = ?", [pending, op.id, PENDING]);
            return;
        }
        // The same op being applied at the same moment by another request (it already has the record): roll this one back.
        const r = d.run("INSERT OR IGNORE INTO applied_ops(op_id, node_id, applied_at, status, response) VALUES (?,?,?,?,?)", [op.id, op.nodeId, realNowIso(), PENDING, pending]);
        if (!r.changes)
            throw new HttpError(409, "This work is already being applied on the main server");
        committing = op;
    },
    afterCommit: () => {
        if (committing)
            committing.recorded = true;
        if (committingPc)
            committingPc.queued = true;
        committing = null;
        committingPc = null;
    },
});
let committing = null, committingPc = null;
/** Most rows one request's id list keeps (a whole-ward run inserts a few thousand). */
const MAX_CREATED = 20_000;
/**
 * Root hooks: repeat-safe replayed writes (the op of the request scope, set by /api/sync/replay). Only for the replays
 * this server sends itself: these hooks run before the session check, so honouring any caller's x-op-id handed a stored
 * answer (patient data) to a request without a session, and let a browser request claim the op id of work a pharmacy PC
 * had not replayed yet (that work was then never applied).
 */
export function opDedupHooks(app) {
    app.addHook("onRequest", async (req, reply) => {
        const op = currentScope()?.op;
        if (!op || !isInternal(req) || !WRITE.has(req.method))
            return;
        const row = db().get("SELECT status, response, node_id FROM applied_ops WHERE op_id = ?", [op.id]);
        if (row) {
            req.opReplayed = true;
            op.closed = true;
            // The PC chooses its op ids: another PC's answer (its patients) is never handed over, and this work is surfaced
            // rather than silently taken as done.
            if (row.node_id != null && row.node_id !== op.nodeId)
                return reply.code(409).type("application/json; charset=utf-8").send(JSON.stringify({ error: "Another PC already sent work with this operation id — re-enter this work" }));
            // PENDING: the work was committed but the server stopped before its answer was recorded — it is applied. Its answer
            // is lost (so what it dispensed is not known), but which rows it made is: map them now, as the answer would have.
            if (row.status === PENDING) {
                let made = [];
                try {
                    made = JSON.parse(row.response ?? "null")?.pendingCreated ?? [];
                }
                catch { /* a record from before: nothing to map */ }
                db().untracked(() => db().tx(() => mapCreatedIds(op, made)));
                return reply.code(200).header("x-op-replayed", "1").type("application/json; charset=utf-8").send(LOST_ANSWER);
            }
            return reply.code(row.status).header("x-op-replayed", "1").type("application/json; charset=utf-8").send(row.response ?? "{}");
        }
    });
    app.addHook("onSend", async (req, reply, payload) => {
        const scope = currentScope(), op = scope?.op;
        if (!op || op.closed || !isInternal(req) || req.opReplayed || !WRITE.has(req.method))
            return payload;
        op.closed = true;
        const status = reply.statusCode, response = typeof payload === "string" ? payload : null;
        db().untracked(() => db().tx(() => {
            // (423: locked meanwhile — the off switch or the licence — not an answer about this work either.)
            if (status >= 500 || status === 401 || status === 423) {
                // Not a final answer, so the PC will send it again. Nothing was committed: it may simply run again. Some work
                // was: running it again could apply that twice — surface it for a person to check instead.
                if (op.recorded)
                    db().run("UPDATE applied_ops SET status = 409, response = ? WHERE op_id = ?", [PARTIAL_ERROR, op.id]);
                return;
            }
            if (op.recorded)
                db().run("UPDATE applied_ops SET status = ?, response = ? WHERE op_id = ?", [status, response, op.id]);
            else
                db().run("INSERT OR IGNORE INTO applied_ops(op_id, node_id, applied_at, status, response) VALUES (?,?,?,?,?)", [op.id, op.nodeId, realNowIso(), status, response]);
            if (status < 300)
                mapCreatedIds(op, scope.created ?? []);
        }));
        return payload;
    });
}
/**
 * Records which row here each row the PC created for this op is: per table, in the order they were inserted. A table
 * where the two sides inserted a different number of rows (e.g. stock taken from two batches here, one on the PC) is
 * left unmapped: work that later refers to those rows fails visibly instead of changing the wrong one.
 */
function mapCreatedIds(op, created) {
    const byTable = (list) => {
        const m = new Map();
        for (const [t, id] of list)
            m.set(t, [...(m.get(t) ?? []), id]);
        return m;
    };
    const here = byTable(created);
    for (const [table, local] of byTable(op.localCreated)) {
        const main = here.get(table);
        if (!main || main.length !== local.length)
            continue;
        local.forEach((id, i) => {
            if (isOfflineId(op.nodeId, id))
                db().run("INSERT OR REPLACE INTO replay_ids(node_id, local_id, main_id, table_name, mapped_at) VALUES (?,?,?,?,?)", [op.nodeId, id, main[i], table, realNowIso()]);
        });
    }
}
/**
 * Rewrites the ids a pharmacy PC gave rows it created offline (in the address and the body of a replayed request) to
 * the ids the main server gave the same rows. Only numbers in that PC's own id range are touched, so nothing else in
 * the request (quantities, batch numbers) can change; ids with no match are left as they are (and then not found).
 */
export function mapOfflineIds(nodeId, text) {
    return rewriteOfflineIds(text, nodeId, (id) => mainIdOf(nodeId, id));
}
const mainIdOf = (nodeId, localId) => db().get("SELECT main_id FROM replay_ids WHERE node_id = ? AND local_id = ?", [nodeId, localId])?.main_id;
/**
 * Forget repeat-protection older than 90 days. A PC repeats an op within minutes of a lost answer; work still waiting in
 * an outbox after that long was never applied, so it needs no record here. (The same for the id map: a PC's copy is
 * refreshed from the main server long before.)
 */
export function pruneAppliedOps(days = 90) {
    const cutoff = toLocalIso(new Date(Date.now() - days * 86_400_000));
    return db().untracked(() => db().run("DELETE FROM applied_ops WHERE applied_at < ?", [cutoff]).changes
        + db().run("DELETE FROM replay_ids WHERE mapped_at < ?", [cutoff]).changes);
}
/** The licence's cap on connected pharmacy PCs (re-registering or re-enabling a PC that already counts is fine). */
function assertPcAllowed(nodeUuid) {
    const max = pharmacyPcLimit();
    if (max == null)
        return;
    const used = db().get("SELECT COUNT(*) c FROM nodes WHERE status = 'active' AND node_uuid <> ?", [nodeUuid])?.c ?? 0;
    if (used >= max)
        throw new HttpError(403, `The licence allows ${max} pharmacy PC${max === 1 ? "" : "s"}. Turn off or remove one in Admin → Network, or ask the system's owner for a larger licence.`);
}
function nodeAuth(req) {
    const t = req.headers["x-node-token"];
    if (typeof t !== "string" || !t)
        throw new HttpError(401, "This PC is not registered with the main server");
    const n = db().get("SELECT id, node_uuid, name, location_id, status, sync_key FROM nodes WHERE token_hash = ?", [sha(t)]);
    if (!n)
        throw new HttpError(401, "This PC is not registered with the main server (it may have been removed)");
    if (n.status !== "active")
        throw new HttpError(403, "This PC has been turned off by an admin", { code: "node_disabled" });
    req.nodeId = n.id;
    db().untracked(() => db().run("UPDATE nodes SET last_seen_at = ?, last_ip = ? WHERE id = ?", [nowIso(), req.ip, n.id]));
    return n;
}
function adminByPassword(ip, username, password) {
    const u = db().get("SELECT * FROM users WHERE username = ? AND active = 1", [username]);
    if (!throttledCheck("register", ip, username, () => checkUserPassword(password, u?.password_hash)))
        throw new HttpError(401, "Wrong username or password");
    const a = accessOf(u);
    if (!a.perms.has("admin.network"))
        throw new HttpError(403, "Only an admin who manages the pharmacy PCs can connect one");
    // an admin who must use two-step sign-in and has not set it up yet cannot connect PCs either
    if (!u.totp_enabled && totpRequiredFor(a))
        throw new HttpError(403, "Set up two-step sign-in on the main server first (sign in there)", { code: "must_enroll_totp" });
    return u;
}
/** Connecting a PC hands it a copy of the database: an admin with two-step sign-in gives their code too. */
function adminSecondFactor(ip, u, code) {
    if (!u.totp_enabled)
        return;
    if (!code)
        throw new HttpError(401, "Type the code from your authenticator app", { code: "needs_code" });
    if (!throttledCheck("register", ip, u.username, () => useSecondFactor(u, code)))
        throw new HttpError(401, "The code is wrong — use the newest code from the app", { code: "needs_code" });
}
/**
 * An encrypted copy of the database for a pharmacy PC, re-keyed with that PC's sync key. PCs' credentials, sign-ins and
 * the main server's sync bookkeeping are removed first, and so are the password hashes of users pinned to another
 * pharmacy than the PC's (their work there could never be applied, see internalCtx, so the PC has no reason to hold what
 * an offline guesser could use). PINs, badges and two-step secrets stay only for the PC's own staff: an administrator
 * (or anyone working across pharmacies) unlocks there with the password, and signs in with two-step on the main server.
 */
export function makeNodeSnapshot(syncKey, locationId) {
    const tmp = dataPath(`snapshot-${randomUUID()}.tmp`);
    const live = db();
    live.snapshotTo(tmp);
    if (live.key === null)
        encryptInPlace(tmp, syncKey);
    else {
        const c = new Database(tmp);
        c.pragma(`key = ${keyPragma(live.key)}`);
        c.pragma(`rekey = ${keyPragma(syncKey)}`);
        c.close();
    }
    const c = new Database(tmp);
    try {
        c.pragma(`key = ${keyPragma(syncKey)}`);
        c.pragma("secure_delete = ON");
        // No sessions at all: the PC keeps its own sign-ins across copies, and a main-server session (an admin's working as
        // this pharmacy, say) would be a live sign-in to the main server for anyone who can read this PC's copy.
        c.exec("DELETE FROM nodes; DELETE FROM applied_ops; DELETE FROM replay_ids; DELETE FROM id_aliases; DELETE FROM sync_issues; DELETE FROM sessions;");
        if (locationId !== undefined) {
            // only users who can work in any pharmacy (by their role, read on the live database) keep theirs everywhere
            const anywhere = live.all("SELECT id, role, role_id FROM users")
                .filter((u) => accessOf(u).perms.has("pharmacies.all")).map((u) => u.id);
            c.prepare(`UPDATE users SET password_hash = '!' WHERE location_id IS NOT NULL AND location_id IS NOT ?
        AND id NOT IN (SELECT value FROM json_each(?))`).run(locationId, JSON.stringify(anywhere));
            // PINs, badges and second-step secrets only of users who work in this pharmacy and are not administrators: a lost
            // PC must not give anyone an administrator's codes (they sign in on the main server instead), and a 4-digit PIN
            // falls to offline guessing
            const keep = live.all("SELECT id, role, role_id, location_id FROM users")
                .filter((u) => (u.location_id == null || u.location_id === locationId) && (() => { const a = accessOf(u); return !a.owner && ![...a.perms].some((p) => p.startsWith("admin.") || p === "pharmacies.all"); })())
                .map((u) => u.id);
            c.prepare(`UPDATE users SET totp_secret = NULL, totp_recovery = NULL, pin_hash = NULL, badge_code = NULL
        WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keep));
            if (live.get("SELECT value AS v FROM settings WHERE key = 'sync.trim_copies'")?.v !== "0")
                trimToPharmacy(c, locationId);
        }
        c.exec("VACUUM");
    }
    finally {
        c.close();
    }
    return tmp;
}
/**
 * A pharmacy PC's copy keeps only its own pharmacy's patients (release 1.8, setting sync.trim_copies): a lost or stolen
 * PC then holds no other pharmacy's patients. Other pharmacies' patients go with their orders, allergies, alerts and
 * interventions; their dispensing and walk-in tickets stay (stock, transfers and analytics need them) without the
 * patient's ID or name; the audit log keeps this pharmacy's lines (less any about those patients); other pharmacies'
 * dispensing runs and the chat between other pharmacies go. Patients with no department stay.
 */
export function trimToPharmacy(c, locationId) {
    c.pragma("foreign_keys = OFF");
    c.exec("DROP TABLE IF EXISTS temp.gone");
    c.prepare(`CREATE TEMP TABLE gone AS SELECT p.id FROM patients p JOIN departments d ON d.id = p.department_id WHERE d.location_id IS NOT ?`).run(locationId);
    const has = (t) => !!c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    c.exec(`DROP TABLE IF EXISTS temp.gone_orders;
    CREATE TEMP TABLE gone_orders AS SELECT CAST(id AS TEXT) AS id FROM medication_orders WHERE patient_id IN (SELECT id FROM temp.gone);`);
    // audit lines about those patients and their orders, whichever pharmacy wrote them (and the ones with no pharmacy)
    c.exec(`DELETE FROM audit_log WHERE (entity = 'patient' AND entity_id IN (SELECT id FROM temp.gone))
    OR (entity = 'order' AND entity_id IN (SELECT id FROM temp.gone_orders))`);
    for (const t of ["medication_orders", "patient_allergies", "safety_alerts", "interventions"])
        if (has(t))
            c.exec(`DELETE FROM ${t} WHERE patient_id IN (SELECT id FROM temp.gone)`);
    for (const t of ["dispensed_slots", "order_edits_after_dispense"])
        if (has(t))
            c.exec(`DELETE FROM ${t} WHERE order_id NOT IN (SELECT id FROM medication_orders)`);
    c.prepare("UPDATE dispenses SET patient_id = NULL, patient_name = NULL WHERE location_id IS NOT ? AND (patient_id IS NOT NULL OR patient_name IS NOT NULL)").run(locationId);
    c.prepare("UPDATE walkin_tickets SET patient_ref = NULL, patient_name = NULL WHERE location_id IS NOT ?").run(locationId);
    if (has("safety_alerts"))
        c.prepare("DELETE FROM safety_alerts WHERE location_id IS NOT ?").run(locationId);
    c.prepare("DELETE FROM audit_log WHERE location_id IS NOT NULL AND location_id IS NOT ?").run(locationId);
    // other pharmacies' runs hold their printed labels (patient names); their chat, between themselves, is theirs
    c.prepare("DELETE FROM dispense_runs WHERE location_id IS NOT ?").run(locationId);
    c.prepare(`DELETE FROM chat_messages WHERE to_location_id IS NOT NULL AND to_location_id IS NOT ?
    AND from_location_id IS NOT ?`).run(locationId, locationId);
    c.exec("DELETE FROM patients WHERE id IN (SELECT id FROM temp.gone); DROP TABLE temp.gone; DROP TABLE temp.gone_orders;");
}
export async function systemRoutes(app) {
    /** What this PC is. Public: the setup screen, pharmacy PCs and network discovery use it. */
    app.get("/info", async () => {
        const c = nodeConfig();
        return { app: "hospital-pharmacy", version: appVersion(), role: c.role, name: c.name, nodeUuid: c.nodeUuid,
            needsSetup: c.role === "unset", serverTime: Date.now() };
    });
}
/** The question of an answer that asks for a confirmation first (409, code needs_force), else null. */
function needsForce(body) {
    try {
        const j = JSON.parse(body);
        return j?.details?.code === "needs_force" ? String(j.error ?? "confirm first") : null;
    }
    catch {
        return null;
    }
}
/** Pharmacy PCs whose replay is running now. */
const replaying = new Set();
export async function syncRoutes(app) {
    const onlyServer = () => { if (nodeConfig().role !== "server")
        throw new HttpError(409, "This PC is not the main server"); };
    /** Step 1 (no locationId): check the admin and list the pharmacies. Step 2: register this PC for one pharmacy. */
    app.post("/register", async (req) => {
        onlyServer();
        const b = parse(z.object({ username: z.string().trim().min(1), password: z.string().min(1), nodeUuid: z.string().uuid(),
            name: z.string().trim().min(1).max(80), locationId: z.coerce.number().int().positive().optional(), code: z.string().trim().max(20).optional() }), req.body);
        const admin = adminByPassword(req.ip, b.username, b.password);
        const locations = db().all("SELECT id, name FROM locations WHERE active = 1 ORDER BY name");
        if (!b.locationId)
            return { serverName: nodeConfig().name, version: appVersion(), locations, needsCode: !!admin.totp_enabled };
        adminSecondFactor(req.ip, admin, b.code);
        if (!locations.some((l) => l.id === b.locationId))
            throw new HttpError(404, "Pharmacy not found");
        assertPcAllowed(b.nodeUuid);
        const token = randomBytes(32).toString("hex"), syncKey = randomBytes(32).toString("hex");
        db().tx(() => {
            const ex = db().get("SELECT id FROM nodes WHERE node_uuid = ?", [b.nodeUuid]);
            if (ex)
                db().run("UPDATE nodes SET name=?, location_id=?, token_hash=?, sync_key=?, status='active', registered_at=?, registered_by=? WHERE id=?", [b.name, b.locationId, sha(token), syncKey, nowIso(), admin.id, ex.id]);
            else
                db().run("INSERT INTO nodes(node_uuid, name, location_id, token_hash, sync_key, registered_at, registered_by) VALUES (?,?,?,?,?,?,?)", [b.nodeUuid, b.name, b.locationId, sha(token), syncKey, nowIso(), admin.id]);
        });
        const node = db().get("SELECT id FROM nodes WHERE node_uuid = ?", [b.nodeUuid]);
        db().run("INSERT INTO audit_log(at, user_id, location_id, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?)", [nowIso(), admin.id, b.locationId, "network.register", "node", String(node.id), JSON.stringify({ name: b.name, ip: req.ip })]);
        return { nodeId: node.id, nodeToken: token, syncKey, serverName: nodeConfig().name, version: appVersion() };
    });
    app.get("/state", async (req) => {
        onlyServer();
        const n = nodeAuth(req);
        return { bootId: db().bootId, revision: db().revision, version: appVersion(), status: n.status, serverTime: Date.now() };
    });
    /** The database copy this pharmacy PC keeps for working offline (encrypted with its sync key). */
    app.get("/snapshot", async (req, reply) => {
        onlyServer();
        const n = nodeAuth(req);
        const state = { bootId: db().bootId, revision: db().revision };
        const file = makeNodeSnapshot(n.sync_key, n.location_id);
        const stream = createReadStream(file);
        stream.on("close", () => rmSync(file, { force: true }));
        return reply.header("content-type", "application/octet-stream").header("content-length", statSync(file).size)
            .header("x-boot-id", state.bootId).header("x-revision", String(state.revision)).send(stream);
    });
    // (No endpoint hands a pharmacy PC a session on the main server: a pharmacy PC signs its users in against its own
    // copy, and a node token that could create main-server sessions for any user — admins included — would let one PC
    // take over the whole hospital.)
    /**
     * Replays work a pharmacy PC did offline, in order, as the pharmacist who did it and at the time they did it.
     * Stops at the first op that fails with a server error (5xx): the ops after it wait, so they are never applied
     * before the work they follow.
     */
    app.post("/replay", async (req) => {
        onlyServer();
        const n = nodeAuth(req);
        const b = parse(z.object({ ops: z.array(z.object({
                opId: z.string().min(8).max(80), at: z.string(), userId: z.number().int(), method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
                url: z.string().startsWith("/api/"), body: z.string().nullable(), locationId: z.number().int().nullish(),
                created: z.array(z.tuple([z.string().max(64), z.number().int()])).max(MAX_CREATED).nullish(),
                uuids: z.array(z.string().uuid()).max(1000).nullish(),
                outcome: z.record(z.string().max(40), z.number()).nullish(),
            })).max(200) }), req.body);
        // One replay per PC at a time: a PC that gave up waiting sends the same work again, and two runs of it interleaving
        // would apply the PC's work out of order. It is told to try again shortly.
        if (replaying.has(n.id))
            throw new HttpError(503, "The main server is still applying this PC's previous work — trying again shortly");
        replaying.add(n.id);
        try {
            const results = [];
            const reject = (opId, status, error) => results.push({ opId, status, body: JSON.stringify({ error }) });
            for (const op of b.ops) {
                // Rows this PC created offline are known here by the ids given to them here (platform/ids.ts).
                const url = mapOfflineIds(n.id, op.url), body = op.body == null ? null : mapOfflineIds(n.id, op.body);
                let path;
                try {
                    path = decodeURIComponent(new URL(url, "http://replay").pathname);
                }
                catch {
                    reject(op.opId, 400, "Invalid address");
                    continue;
                }
                if (REPLAY_FORBIDDEN.test(path) || REPLAY_FORBIDDEN.test(url)) {
                    reject(op.opId, 403, "Not allowed from a pharmacy PC");
                    continue;
                }
                // The main server applies a PC's work to that PC's pharmacy only; work done there as another pharmacy is surfaced.
                if (op.locationId != null && op.locationId !== n.location_id) {
                    reject(op.opId, 409, "This work was done as another pharmacy on this PC — re-enter it there");
                    continue;
                }
                const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(op.at) ? parseLocal(op.at) : null;
                if (!at) {
                    reject(op.opId, 400, "Invalid time on this work");
                    continue;
                }
                const localCreated = (op.created ?? []).filter(([, id]) => isOfflineId(n.id, id));
                // The PC hands out an id again only after its copy was replaced; whatever it meant before is no longer meant.
                if (localCreated.length && !db().get("SELECT 1 FROM applied_ops WHERE op_id = ?", [op.opId]))
                    db().untracked(() => db().tx(() => { for (const [, id] of localCreated)
                        db().run("DELETE FROM replay_ids WHERE node_id = ? AND local_id = ?", [n.id, id]); }));
                // Everything this request runs (and only it) sees the time the pharmacist did the work, and this op. The request
                // must start inside the scope: app.inject() without a callback starts only when awaited, and an await here runs
                // outside it — every op after the first of a batch then ran at the time of the sync.
                // (The run ids the PC gave its runs are used again here, so the same run has the same id on both.)
                const scope = { at, op: { id: op.opId, nodeId: n.id, localCreated, recorded: false, closed: false }, created: [], reuseUuids: [...(op.uuids ?? [])] };
                const r = await withScope(scope, () => new Promise((resolve, fail) => app.inject({
                    method: op.method, url, payload: body ?? undefined,
                    // (no content type without a body: a DELETE recorded with none would be refused as "body cannot be empty")
                    headers: { ...(body != null ? { "content-type": "application/json" } : {}), "x-op-id": op.opId, "x-hps-internal": INTERNAL, "x-hps-user": String(op.userId),
                        "x-hps-location": String(n.location_id), "x-hps-node": String(n.id) },
                }, (err, res) => (err || !res ? fail(err) : resolve(res)))));
                // A walk-in ticket that is short of stock here answers "confirm what to do" and dispenses nothing; the pharmacist
                // who could confirm is not here, so this is work that was not applied.
                // Locked meanwhile (the off switch arrived, or the licence's grace period ended, mid-batch): not this work's fault —
                // answered as a server error so the PC keeps it and sends it again, instead of filing it as rejected.
                if (r.statusCode === 423) {
                    results.push({ opId: op.opId, status: 503, body: r.body });
                    break;
                }
                if (r.statusCode < 300 && /"needsConfirm":true/.test(r.body))
                    reject(op.opId, 409, "Not enough stock on the main server to dispense this ticket — check the stock and dispense it again");
                // The main server asks first (its history differs from the PC's copy: a dose given meanwhile from another PC, a
                // day that has ended): nothing was done, and only a pharmacist can answer — say so, instead of the bare question.
                else if (r.statusCode === 409 && needsForce(r.body))
                    reject(op.opId, 409, `Not applied: the main server asks first — "${needsForce(r.body)}". Nothing was dispensed or changed there; check, and do it again if it is still needed`);
                else {
                    // Which id here each row the PC made got, so the PC can still find them by their old ids after its next copy.
                    const ids = [];
                    if (r.statusCode < 300)
                        for (const [, id] of localCreated) {
                            const m = mainIdOf(n.id, id);
                            if (m !== undefined)
                                ids.push([id, m]);
                        }
                    // Applied, but dispensing less than it did on the PC (less stock here): applied, and reported for a person to check.
                    // (An answer lost to a stop of the server says nothing about what was dispensed: not "less" — ask to check it.)
                    const warning = !(r.statusCode < 300 && op.outcome) ? null : r.body === LOST_ANSWER
                        ? "Applied on the main server, but it stopped before it recorded what it dispensed there — check this work in the main server's records before doing anything again"
                        : outcomeDifference(op.outcome, outcomeOf(r.body));
                    results.push({ opId: op.opId, status: r.statusCode, body: r.body, ...(ids.length ? { ids } : {}), ...(warning ? { warning } : {}) });
                }
                if (r.statusCode >= 500)
                    break;
            }
            db().untracked(() => db().run("UPDATE nodes SET last_sync_at = ? WHERE id = ?", [nowIso(), n.id]));
            return { results };
        }
        finally {
            replaying.delete(n.id);
        }
    });
    /**
     * The signed package of the version this main server runs, for pharmacy PCs to update themselves without the
     * internet. The PC checks the owner's signature itself, so this server can only pass on releases the owner signed.
     */
    app.get("/release", async (req) => {
        onlyServer();
        nodeAuth(req);
        try {
            const rel = await ensureReleaseCached(appVersion());
            return { version: rel.version, manifest: rel.text, sig: rel.sig };
        }
        catch (e) {
            throw new HttpError(503, `The main server does not have its update package: ${e?.message ?? e}`);
        }
    });
    app.get("/release/file", async (req, reply) => {
        onlyServer();
        nodeAuth(req);
        let rel;
        try {
            rel = await ensureReleaseCached(appVersion());
        }
        catch {
            throw new HttpError(503, "The main server does not have its update package");
        }
        const file = cachedReleaseFile(rel, String(req.query.path ?? ""));
        if (!file)
            throw new HttpError(404, "Not part of this release");
        return reply.header("content-type", "application/octet-stream").send(createReadStream(file));
    });
    /** Every 30 s: the PC's state; the answer says whether it may keep working. */
    app.post("/heartbeat", async (req) => {
        onlyServer();
        const n = nodeAuth(req);
        const b = parse(z.object({
            version: z.string().max(40), pendingOps: z.number().int().min(0), failedOps: z.number().int().min(0),
            offlineSince: z.string().nullable(), lastSyncAt: z.string().nullable(),
            issues: z.array(z.object({ opId: z.string(), at: z.string(), userId: z.number().int().nullable(), method: z.string(), url: z.string(),
                body: z.string().nullable(), status: z.number().int().nullable(), error: z.string().nullable() })).max(500).default([]),
            /** Every op the PC still lists as failed: it drops the ones an admin has resolved here. */
            failures: z.array(z.string().max(80)).max(2000).default([]),
            /** When this PC's chat screen last checked in (its presence; the PC does not queue chat heartbeats). */
            chatSeen: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).nullish(),
        }), req.body);
        db().untracked(() => db().tx(() => {
            db().run("UPDATE nodes SET version=?, pending_ops=?, failed_ops=?, offline_since=?, last_sync_at=COALESCE(?, last_sync_at) WHERE id=?", [b.version, b.pendingOps, b.failedOps, b.offlineSince, b.lastSyncAt, n.id]);
            for (const i of b.issues)
                db().run(`INSERT INTO sync_issues(node_id, op_id, at, user_id, method, url, body, status, error, reported_at) VALUES (?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(node_id, op_id) DO UPDATE SET status = excluded.status, error = excluded.error`, [n.id, i.opId, i.at, i.userId, i.method, i.url, carriesPassword(i.url) ? null : i.body, i.status, i.error, nowIso()]); // (a PC from before it left passwords out)
            if (b.chatSeen && n.location_id != null)
                db().run(`INSERT INTO chat_presence(location_id, last_seen, last_read_message_id) VALUES (?,?,0)
                  ON CONFLICT(location_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`, [n.location_id, b.chatSeen]);
        }));
        const resolved = b.failures.filter((opId) => db().get("SELECT 1 FROM sync_issues WHERE node_id = ? AND op_id = ? AND resolved_at IS NOT NULL", [n.id, opId]));
        const lock = lockState();
        // A working main server is licensed (or in its grace period): that confirms the PC's licence too.
        const lic = licenceStatus();
        // the main server's certificate, vouched for with this PC's own sync key (a PC still on plain HTTP takes it only
        // when that matches: someone in the middle cannot hand it theirs); whether this PC already talks over TLS
        const tls = tlsInfo();
        const encrypted = !!req.raw.socket.encrypted;
        db().untracked(() => db().run("UPDATE nodes SET tls = ? WHERE id = ?", [encrypted ? 1 : 0, n.id]));
        return { status: n.status, serverVersion: appVersion(), serverTime: Date.now(), killed: lock.locked, lockMessage: lock.message,
            licence: { ok: lic.state !== "unlicensed", offlineDays: lic.offlineDays }, resolved,
            ...(tls ? { tlsCert: tls.cert, tlsMac: certMac(n.sync_key, tls.cert) } : {}) };
    });
}
/** Admin -> Network (main server). */
export async function networkRoutes(app) {
    // Restoring a database and the recovery key are the owner's alone: either lets someone put in a database of their
    // making, with any account as the owner. The rest is managing the pharmacy PCs.
    app.addHook("preHandler", async (req) => {
        if (/\/(restore|recovery-key)$/.test(req.routeOptions?.url ?? ""))
            requireOwner(req);
        else
            requirePerm(req, "admin.network");
    });
    app.get("/", async () => {
        const c = nodeConfig();
        const nodes = c.role === "server" ? db().all(`SELECT n.id, n.name, n.node_uuid AS nodeUuid, n.location_id AS locationId, l.name AS locationName,
        n.status, n.registered_at AS registeredAt, n.last_seen_at AS lastSeenAt, n.last_ip AS lastIp, n.version,
        n.pending_ops AS pendingOps, n.failed_ops AS failedOps, n.offline_since AS offlineSince, n.last_sync_at AS lastSyncAt, n.tls
      FROM nodes n LEFT JOIN locations l ON l.id = n.location_id ORDER BY l.name, n.name`) : [];
        const issues = c.role === "server" ? db().all(`SELECT i.id, i.node_id AS nodeId, n.name AS nodeName, i.op_id AS opId, i.at, i.user_id AS userId,
        u.display_name AS userName, i.method, i.url, i.body, i.status, i.error, i.reported_at AS reportedAt
      FROM sync_issues i JOIN nodes n ON n.id = i.node_id LEFT JOIN users u ON u.id = i.user_id
      WHERE i.resolved_at IS NULL ORDER BY i.at`) : [];
        const tls = tlsInfo();
        return { self: { role: c.role, name: c.name, nodeUuid: c.nodeUuid, version: appVersion(), dataDir: dataPath(), encrypted: db().key !== null,
                tls: tls ? { fingerprint: tls.fingerprint, validTo: tls.validTo } : null, serverCertPinned: c.role === "pharmacy" ? !!c.serverCert : null },
            nodes, issues };
    });
    /** The main server's certificate, for browsers on other PCs to trust (so https:// opens without a warning). */
    app.get("/certificate", async (_req, reply) => {
        const tls = tlsInfo();
        if (!tls)
            throw new HttpError(404, "This PC does not answer over HTTPS");
        return reply.header("content-type", "application/x-x509-ca-cert").header("content-disposition", 'attachment; filename="hospital-pharmacy-server.crt"').send(tls.cert);
    });
    app.post("/nodes/:id/status", async (req) => {
        const { status } = parse(z.object({ status: z.enum(["active", "disabled"]) }), req.body);
        if (status === "active") {
            const uuid = db().get("SELECT node_uuid FROM nodes WHERE id = ?", [Number(req.params.id)])?.node_uuid;
            if (uuid)
                assertPcAllowed(uuid);
        }
        const r = db().run("UPDATE nodes SET status = ? WHERE id = ?", [status, Number(req.params.id)]);
        if (!r.changes)
            throw new HttpError(404, "PC not found");
        audit(req, `network.node.${status === "active" ? "enable" : "disable"}`, "node", req.params.id);
        return { ok: true };
    });
    app.delete("/nodes/:id", async (req) => {
        const r = db().run("DELETE FROM nodes WHERE id = ?", [Number(req.params.id)]);
        if (!r.changes)
            throw new HttpError(404, "PC not found");
        db().run("DELETE FROM replay_ids WHERE node_id = ?", [Number(req.params.id)]);
        audit(req, "network.node.remove", "node", req.params.id);
        return { ok: true };
    });
    app.post("/issues/:id/resolve", async (req) => {
        const { resolution } = parse(z.object({ resolution: z.string().trim().min(1).max(500) }), req.body);
        const r = db().run("UPDATE sync_issues SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL", [nowIso(), req.ctx.userId, resolution, Number(req.params.id)]);
        if (!r.changes)
            throw new HttpError(404, "Problem not found");
        audit(req, "network.issue.resolve", "sync_issue", req.params.id, { resolution });
        return { ok: true };
    });
    /** The database recovery key, after the admin types their password again. */
    app.post("/recovery-key", async (req) => {
        const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
        const u = db().get("SELECT password_hash FROM users WHERE id = ?", [req.ctx.userId]);
        if (!throttledCheck("reauth", req.ip, req.ctx.username, () => !!u && verifyPassword(password, u.password_hash)))
            throw new HttpError(401, "Wrong password");
        const key = db().key;
        if (!key)
            throw new HttpError(409, "This database is not encrypted (development mode)");
        audit(req, "network.recovery_key.view");
        return { key: formatRecoveryKey(key), file: dataPath() };
    });
    /**
     * Replace this PC's database with an uploaded one: a backup of this system (needs its recovery key unless it was made
     * on this server) or a plain SQLite database. The current database is kept as pharmacy.sqlite.previous.
     */
    app.post("/restore", { bodyLimit: 1024 * 1024 * 1024 }, async (req, reply) => {
        if (nodeConfig().role !== "server")
            throw new HttpError(409, "Restore a database on the main server; pharmacy PCs copy it from there");
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length < 512)
            throw new HttpError(400, "Upload a database file");
        const keyHeader = req.headers["x-recovery-key"];
        const tmp = dataPath(`restore-${randomUUID()}.tmp`);
        writeFileSync(tmp, body);
        try {
            const live = db();
            const plain = body.subarray(0, 16).toString("latin1") === "SQLite format 3\0";
            if (!plain && typeof keyHeader === "string" && keyHeader.trim()) {
                // A backup from another server: open with its key and re-key to ours.
                let other;
                try {
                    other = parseRecoveryKey(keyHeader);
                }
                catch (e) {
                    throw new HttpError(400, e.message);
                }
                const c = new Database(tmp);
                c.pragma(`key = ${keyPragma(other)}`);
                try {
                    c.prepare("SELECT count(*) FROM sqlite_master").get();
                }
                catch {
                    c.close();
                    throw new HttpError(400, "That recovery key does not open this file");
                }
                if (live.key)
                    c.pragma(`rekey = ${keyPragma(live.key)}`);
                c.close();
            }
            else if (plain && live.key)
                encryptInPlace(tmp, live.key);
            // Must look like this system's database.
            const probe = new Db(tmp, live.key);
            try {
                probe.get("SELECT count(*) FROM users");
                probe.get("SELECT count(*) FROM patients");
            }
            catch {
                throw new HttpError(400, "This file is not a Hospital Pharmacy database (or needs its recovery key)");
            }
            finally {
                probe.close();
            }
            const userId = req.ctx.userId;
            replaceDb(tmp);
            // Everyone signs in again (as the admin was told): the restored file brings back the sign-ins it had when it was
            // made, including ones signed out since.
            db().run("DELETE FROM sessions");
            // (The admin's user id may not exist in a database restored from another server.)
            db().run("INSERT INTO audit_log(at, user_id, action, entity, details) VALUES (?, (SELECT id FROM users WHERE id = ?), ?, ?, ?)", [nowIso(), userId, "network.restore", "database", JSON.stringify({ size: body.length })]);
            return reply.send({ ok: true, size: body.length });
        }
        finally {
            rmSync(tmp, { force: true });
        }
    });
}
