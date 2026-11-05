import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { featureOn } from "../core/feature-gate.js";
import { settingNum } from "../core/settings.js";
import { accessOf } from "../auth/access.js";
import { COOKIE } from "../auth/routes.js";
import { nowIso, toLocalIso } from "../lib/time.js";
import { nodeConfig } from "./node-config.js";
import { b64, importPrivate, linkCodeText, linkProof, newKeyPair, openRequest, phoneCode, privateText, publicText, relayMac, relayMacKey, serverIdOf, sha256Text, } from "./phone-crypto.js";
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]);
/* ---------------- this server's key and the relay ---------------- */
let ownKey = null;
/** This main server's key for phones (made once, kept in the encrypted database; never in a pharmacy PC's copy). */
export function serverKey() {
    ownKey ??= (async () => {
        let priv = META("phone_key_priv"), pub = META("phone_key_pub");
        if (!priv || !pub) {
            const k = await newKeyPair();
            priv = await privateText(k.privateKey);
            pub = await publicText(k.publicKey);
            SET("phone_key_priv", priv);
            SET("phone_key_pub", pub);
        }
        return { priv: await importPrivate(priv), pub, id: await serverIdOf(pub) };
    })();
    return ownKey;
}
/** (tests) */
export function resetPhoneState() { ownKey = null; links.clear(); seen.clear(); phoneTokens.clear(); relayState = { macKey: null, relayPub: null }; }
/**
 * The relay's address: the one the owner publishes in the signed control file (control.json relayUrl), so nobody but
 * the owner can point a hospital's phones elsewhere. https only (http inside a private network, for testing).
 */
export function relayUrl() {
    // HPS_RELAY_URL on the main server PC itself: a relay the hospital runs (testing, or its own). Harmless: a phone
    // trusts only this server's key, from the QR code, and a relay can read nothing.
    const u = process.env.HPS_RELAY_URL || META("relay_url");
    if (!u)
        return null;
    try {
        const p = new URL(u);
        const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(p.hostname);
        return p.protocol === "https:" || (p.protocol === "http:" && local) ? p.origin : null;
    }
    catch {
        return null;
    }
}
export function setRelayUrl(u) { SET("relay_url", u ?? ""); }
/** Phones can be linked here: the main server, the feature on and an address for the relay. */
export const phonesAvailable = () => nodeConfig().role === "server" && featureOn("phone_app") && !!relayUrl();
const links = new Map();
export const LINK_MINUTES = 5;
/** A new one-time link for `userId`: the QR code's text. */
export async function startLink(userId) {
    const k = await serverKey();
    for (const [id, l] of links)
        if (l.expires < Date.now())
            links.delete(id);
    // a phone that claimed a code nobody confirmed in time is forgotten (it never worked)
    db().run("DELETE FROM phone_devices WHERE status = 'pending' AND created_at < ?", [toLocalIso(new Date(Date.now() - LINK_MINUTES * 60_000))]);
    const id = b64(randomBytes(9)), secret = b64(randomBytes(24));
    links.set(id, { userId, secret, expires: Date.now() + LINK_MINUTES * 60_000 });
    return { linkId: id, expiresAt: toLocalIso(new Date(Date.now() + LINK_MINUTES * 60_000)),
        code: linkCodeText({ r: relayUrl() ?? "", s: k.id, k: k.pub, l: id, x: secret }) };
}
/** Where a link stands, for the PC's screen (only its own user's). */
export function linkState(linkId, userId) {
    const l = links.get(linkId);
    if (!l || l.userId !== userId)
        return null;
    if (l.confirmed)
        return { state: "linked" };
    if (!l.deviceId)
        return { state: l.expires < Date.now() ? "expired" : "waiting" };
    const d = db().get("SELECT id, name, code FROM phone_devices WHERE id = ?", [l.deviceId]);
    return d ? { state: "claimed", device: d } : { state: "expired" };
}
/** The user confirmed on the PC that the phone shows the same code: the phone works from now on. */
export function confirmLink(linkId, userId) {
    const l = links.get(linkId);
    if (!l || l.userId !== userId || !l.deviceId || l.confirmed)
        return null;
    const ok = db().run("UPDATE phone_devices SET status = 'active', confirmed_at = ? WHERE id = ? AND status = 'pending'", [nowIso(), l.deviceId]).changes;
    if (!ok)
        return null;
    l.confirmed = true;
    return l.deviceId;
}
/** Cut a phone off (its user, or an admin). Its sessions end too. */
export function removeDevice(id) {
    const n = db().run("UPDATE phone_devices SET status = 'removed', removed_at = ? WHERE id = ? AND status != 'removed'", [nowIso(), id]).changes;
    db().run("DELETE FROM sessions WHERE device_id = ?", [id]);
    for (const [d] of phoneTokens)
        if (d === id)
            phoneTokens.delete(d);
    return n > 0;
}
/* ---------------- a phone's request ---------------- */
/**
 * What a phone may reach: the screens it has. Anything else answers 403 here, before any route runs. (Changing a
 * route's permission still applies on top: this only narrows.)
 */
export const PHONE_ROUTES = [
    { method: "GET", path: /^\/api\/auth\/(me|branding)$/ },
    { method: "GET", path: /^\/api\/analytics(\/[A-Za-z0-9_\-/]*)?$/ },
    { method: "GET", path: /^\/api\/chat\/(rooms|rooms\/\d+\/messages|presence|unread)$/ },
    { method: "POST", path: /^\/api\/chat\/(rooms\/\d+\/messages|read|heartbeat)$/ },
];
export const phoneMayCall = (method, url) => {
    const path = url.split("?")[0];
    return !path.includes("..") && !/%2e|%2f/i.test(path) && PHONE_ROUTES.some((r) => r.method === method && r.path.test(path));
};
/** The user's open PC session (not a phone's), or null: the phone works only while there is one. */
export function openPcSession(userId) {
    const idle = featureOn("screen_lock") ? settingNum("auth.idle_lock_minutes") : 0;
    const since = idle > 0 ? toLocalIso(new Date(Date.now() - idle * 60_000)) : "";
    return db().get(`SELECT token, location_id, expires_at FROM sessions WHERE user_id = ? AND device_id IS NULL AND expires_at > ? AND locked_at IS NULL
       AND COALESCE(last_seen_at, created_at) >= ? ORDER BY last_seen_at DESC LIMIT 1`, [userId, nowIso(), since]) ?? null;
}
/** The phone's own session (kept beside the PC's, ending with it): what its requests run in. */
const phoneTokens = new Map();
function phoneSession(deviceId, userId, pc) {
    let token = phoneTokens.get(deviceId);
    const s = token ? db().get("SELECT token FROM sessions WHERE token = ? AND device_id = ? AND expires_at > ?", [token, deviceId, nowIso()]) : undefined;
    db().untracked(() => {
        if (!s) {
            token = randomBytes(32).toString("hex");
            db().run("DELETE FROM sessions WHERE device_id = ?", [deviceId]);
            db().run("INSERT INTO sessions(token,user_id,location_id,created_at,expires_at,last_seen_at,device_id) VALUES (?,?,?,?,?,?,?)", [token, userId, pc.location_id, nowIso(), pc.expires_at, nowIso(), deviceId]);
            phoneTokens.set(deviceId, token);
        }
        else {
            // the PC's pharmacy and end time; never locked by itself (the PC's session is what locks)
            db().run("UPDATE sessions SET location_id = ?, expires_at = ?, last_seen_at = ?, locked_at = NULL WHERE token = ?", [pc.location_id, pc.expires_at, nowIso(), token]);
        }
    });
    return token;
}
/** Each request's own id, taken once (two minutes either side of now). */
const seen = new Map();
const REPLAY_MS = 120_000;
function freshRequest(id, at) {
    const now = Date.now();
    for (const [k, t] of seen)
        if (t < now - 2 * REPLAY_MS)
            seen.delete(k);
    if (typeof id !== "string" || id.length < 8 || id.length > 64 || typeof at !== "number" || Math.abs(now - at) > REPLAY_MS || seen.has(id))
        return false;
    seen.set(id, now);
    return true;
}
const refuse = (status, error, code) => ({ status, body: { error, code } });
/**
 * One envelope from a phone, as the relay passed it: opens it, does what it asks, and seals the answer. Anything that
 * is not a sealed request from this server's phones gets a plain refusal (it says nothing about the hospital).
 */
export async function handleEnvelope(app, text) {
    const plainNo = { status: 400, body: JSON.stringify({ error: "Refused", code: "refused" }) };
    let env;
    try {
        env = JSON.parse(text);
    }
    catch {
        return plainNo;
    }
    const k = await serverKey();
    let opened;
    try {
        opened = await openRequest({ serverId: k.id, serverPriv: k.priv, env,
            phonePub: (id) => db().get("SELECT public_key FROM phone_devices WHERE id = ?", [id])?.public_key ?? null });
    }
    catch {
        return plainNo;
    }
    const answer = await act(app, env, opened.body, opened.phonePub);
    return { status: 200, body: JSON.stringify(await opened.answer(answer)) };
}
async function act(app, env, req, phonePub) {
    if (!req || typeof req !== "object" || !freshRequest(req.id, req.at))
        return refuse(400, "Refused", "refused");
    if (nodeConfig().role !== "server" || !featureOn("phone_app"))
        return refuse(403, "The phone app is turned off at the hospital", "feature_off");
    if (req.t === "link") {
        // a phone that scanned a link code: only with its own public key (not a linked phone's id) and the code's proof
        const l = typeof req.link === "string" ? links.get(req.link) : undefined;
        if (env.d != null || !l || l.expires < Date.now() || l.deviceId)
            return refuse(410, "This link code has expired: show a new one on the PC", "link_expired");
        if (typeof req.proof !== "string" || req.proof !== await linkProof(l.secret, phonePub))
            return refuse(403, "Refused", "refused");
        const name = String(req.name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Phone";
        if (db().get("SELECT 1 FROM phone_devices WHERE public_key = ?", [phonePub]))
            return refuse(409, "This phone is already linked", "already_linked");
        const code = await phoneCode(phonePub);
        const id = Number(db().run("INSERT INTO phone_devices(user_id,name,public_key,code,status,created_at) VALUES (?,?,?,?,?,?)", [l.userId, name, phonePub, code, "pending", nowIso()]).lastId);
        l.deviceId = id;
        db().run("INSERT INTO audit_log(at,user_id,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)", [nowIso(), l.userId, "phone.link.request", "phone_device", String(id), JSON.stringify({ name, code })]);
        return { status: 200, body: { deviceId: id, code, state: "pending" } };
    }
    if (req.t !== "req" || env.d == null)
        return refuse(400, "Refused", "refused");
    const d = db().get("SELECT id, user_id, status FROM phone_devices WHERE id = ?", [env.d]);
    if (!d || d.status === "removed")
        return refuse(401, "This phone has been removed: link it again from a PC", "phone_removed");
    if (d.status !== "active")
        return refuse(409, "Confirm the code on the PC first", "phone_not_confirmed");
    const u = db().get("SELECT id, role, role_id, active FROM users WHERE id = ?", [d.user_id]);
    if (!u?.active)
        return refuse(401, "This account is stopped", "account_stopped");
    const access = accessOf(u);
    if (!access.owner && !access.perms.has("phone"))
        return refuse(403, "Your role does not include the phone app", "no_permission");
    db().untracked(() => db().run("UPDATE phone_devices SET last_seen_at = ? WHERE id = ?", [nowIso(), d.id]));
    const method = String(req.m ?? "GET").toUpperCase(), url = String(req.u ?? "");
    if (!url.startsWith("/api/") || !phoneMayCall(method, url))
        return refuse(403, "The phone app cannot open this", "not_on_phone");
    const pc = openPcSession(u.id);
    if (!pc)
        return refuse(423, "Open your account on a PC to use the phone", "pc_session_required");
    const token = phoneSession(d.id, u.id, pc);
    const res = await app.inject({ method: method, url, headers: { host: "localhost", "content-type": "application/json" },
        cookies: { [COOKIE]: token }, ...(method === "GET" ? {} : { payload: JSON.stringify(req.b ?? {}) }) });
    let body = null;
    try {
        body = res.body ? JSON.parse(res.body) : null;
    }
    catch {
        body = { error: "Unexpected answer" };
    }
    return { status: res.statusCode, body };
}
/* ---------------- talking to the relay ---------------- */
let relayState = { macKey: null, relayPub: null };
export let relayContact = { at: null, ok: false };
async function signedHeaders(what, body, base) {
    const k = await serverKey();
    if (!relayState.macKey) {
        const r = await fetch(`${base}/api/relay/key`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok)
            throw new Error(`The relay answered ${r.status}`);
        const { pub } = await r.json();
        relayState = { macKey: await relayMacKey(k.priv, pub), relayPub: pub };
    }
    const at = Date.now();
    return { "content-type": "application/json", "x-hps-relay-server": k.id, "x-hps-relay-pub": k.pub, "x-hps-relay-time": String(at),
        "x-hps-relay-sig": await relayMac(relayState.macKey, `${what}|${k.id}|${at}|${await sha256Text(body)}`) };
}
/** One poll of the relay: answers every envelope it hands over. Returns how many there were. */
export async function pollRelayOnce(app, base = relayUrl()) {
    if (!base)
        return 0;
    const body = "{}";
    const r = await fetch(`${base}/api/relay/poll`, { method: "POST", headers: await signedHeaders("poll", body, base), body, signal: AbortSignal.timeout(40_000) });
    if (r.status === 401) {
        relayState = { macKey: null, relayPub: null };
        throw new Error("The relay refused this server's signature");
    }
    if (!r.ok)
        throw new Error(`The relay answered ${r.status}`);
    const { items } = await r.json();
    await Promise.all(items.map(async (it) => {
        const a = await handleEnvelope(app, it.body).catch(() => ({ status: 400, body: JSON.stringify({ error: "Refused", code: "refused" }) }));
        const rb = JSON.stringify({ id: it.id, status: a.status, body: a.body });
        await fetch(`${base}/api/relay/reply`, { method: "POST", headers: await signedHeaders("reply", rb, base), body: rb, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    }));
    relayContact = { at: nowIso(), ok: true };
    return items.length;
}
let running = false;
/** The main server's loop: while phones can be used, keep a poll open at the relay. */
export function startPhoneRelay(app) {
    if (running)
        return;
    running = true;
    let backoff = 5_000;
    const loop = async () => {
        for (;;) {
            if (!phonesAvailable()) {
                await new Promise((r) => setTimeout(r, 30_000));
                continue;
            }
            try {
                await pollRelayOnce(app);
                backoff = 5_000;
            }
            catch (e) {
                relayContact = { at: nowIso(), ok: false, error: String(e?.message ?? e) };
                await new Promise((r) => setTimeout(r, backoff));
                backoff = Math.min(backoff * 2, 120_000);
            }
        }
    };
    void loop();
}
