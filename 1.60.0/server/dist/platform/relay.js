// The phone relay (release 1.47, docs/PHONE.md). Runs on the owner's own server, reachable from the internet by its
// public name. Phones on mobile data and the hospitals' main servers both call it; neither has to accept a connection
// from outside. It only passes sealed envelopes along (platform/phone-crypto.ts): it cannot read a request or an
// answer, and keeps nothing on disk but its own key.
//
//   POST /api/relay/to/:server   a phone's envelope for that hospital; answered with the hospital's sealed answer
//                                (or 503 hospital_offline, 504 no answer in time)
//   POST /api/relay/poll         a main server collects the envelopes waiting for it (held up to 25 s)
//   POST /api/relay/reply        a main server's answer to one of them
//   GET  /api/relay/key          the relay's public key (the main servers derive their signing key with it)
//
// A main server signs poll and reply with a key only it and the relay can derive (relayMacKey: ECDH of its own key
// and the relay's), and proves the id it polls for is its own public key's (serverIdOf). Nothing is taken until the
// owner turns the relay on (Admin → Fleet).
import { importPrivate, newKeyPair, privateText, publicText, relayMacKey, relayMacOk, serverIdOf, sha256Text } from "./phone-crypto.js";
import { fetchControl } from "./releases.js";
let store = null;
export function setRelayStore(s) { store = s; ownKey = null; }
const st = () => { if (!store)
    throw new Error("The relay has no store"); return store; };
const META = (k) => st().get(k);
const SET = (k, v) => st().set(k, v);
export const relayOn = () => META("relay_receive") === "1";
export function setRelayOn(on) { SET("relay_receive", on ? "1" : ""); }
let ownKey = null;
/** The relay's own key (made once, kept in the encrypted database). */
export function relayKey() {
    ownKey ??= (async () => {
        let priv = META("relay_key_priv"), pub = META("relay_key_pub");
        if (!priv || !pub) {
            const k = await newKeyPair();
            priv = await privateText(k.privateKey);
            pub = await publicText(k.publicKey);
            SET("relay_key_priv", priv);
            SET("relay_key_pub", pub);
        }
        return { priv: await importPrivate(priv), pub };
    })();
    return ownKey;
}
/** How long a phone waits for its hospital's answer, and a main server's poll is held open. */
export const ANSWER_WAIT_MS = 30_000, POLL_HOLD_MS = 25_000;
/** A hospital that has not polled for this long is offline (its phones are told so at once). */
const OFFLINE_AFTER_MS = 60_000;
// (1.50) answers can be larger than requests: a whole screen's list, packed
const MAX_WAITING = 50, MAX_BODY = 512 * 1024, MAX_REPLY = 4 * 1024 * 1024, CLOCK_SKEW_MS = 120_000;
const hospitals = new Map();
/** (tests) */
export function resetRelay() { hospitals.clear(); ownKey = null; }
let seq = 0;
const take = (h, n = 10) => { const items = h.queue.splice(0, n); for (const w of items)
    h.inflight.set(w.id, w); return items; };
/** A phone's envelope for `server`: resolves with what goes back to the phone. */
export function toHospital(server, body, now = Date.now()) {
    if (!relayOn())
        return Promise.resolve({ status: 404, body: JSON.stringify({ error: "Not found" }) });
    const h = hospitals.get(server);
    if (!h || now - h.lastPoll > OFFLINE_AFTER_MS)
        return Promise.resolve({ status: 503, body: JSON.stringify({ error: "The hospital's main server is not connected", code: "hospital_offline" }) });
    if (body.length > MAX_BODY)
        return Promise.resolve({ status: 413, body: JSON.stringify({ error: "Too large" }) });
    if (h.queue.length + h.inflight.size >= MAX_WAITING)
        return Promise.resolve({ status: 429, body: JSON.stringify({ error: "Too many requests waiting for this hospital", code: "busy" }) });
    return new Promise((done) => {
        const w = { id: `${Date.now().toString(36)}-${(++seq).toString(36)}`, body, done: (a) => { clearTimeout(t); done(a); } };
        const t = setTimeout(() => {
            h.queue = h.queue.filter((x) => x !== w);
            h.inflight.delete(w.id);
            done({ status: 504, body: JSON.stringify({ error: "The hospital did not answer in time", code: "no_answer" }) });
        }, ANSWER_WAIT_MS);
        h.queue.push(w);
        if (h.poller) {
            const p = h.poller;
            h.poller = null;
            p(take(h));
        }
    });
}
/** Checks a main server's signed call; returns its hospital entry (made on its first poll), or null. */
async function signedBy(headers, what, body) {
    const server = String(headers["x-hps-relay-server"] ?? ""), pub = String(headers["x-hps-relay-pub"] ?? "");
    const at = Number(headers["x-hps-relay-time"]), mac = String(headers["x-hps-relay-sig"] ?? "");
    if (!server || !pub || !mac || !Number.isFinite(at) || Math.abs(Date.now() - at) > CLOCK_SKEW_MS)
        return null;
    if ((await serverIdOf(pub).catch(() => "")) !== server)
        return null;
    let h = hospitals.get(server);
    const macKey = h?.macKey ?? await relayMacKey((await relayKey()).priv, pub).catch(() => null);
    if (!macKey)
        return null;
    if (!(await relayMacOk(macKey, `${what}|${server}|${at}|${await sha256Text(body)}`, mac)))
        return null;
    if (!h) {
        h = { queue: [], inflight: new Map(), poller: null, lastPoll: 0, macKey, pub };
        hospitals.set(server, h);
    }
    return { server, h };
}
/** A main server's poll: the envelopes waiting for it, held open until one comes or POLL_HOLD_MS passes. */
export async function pollFor(headers, body, holdMs = POLL_HOLD_MS) {
    if (!relayOn())
        return { status: 404, items: [] };
    const s = await signedBy(headers, "poll", body);
    if (!s)
        return { status: 401, items: [] };
    const { h } = s;
    h.lastPoll = Date.now();
    // (1.58) the server's machine code, in its signed poll: how the owner's remote access finds it (findByMachine)
    try {
        const m = JSON.parse(body)?.m;
        h.machine = typeof m === "string" && /^[0-9a-f]{8,64}$/.test(m) ? m : undefined;
    }
    catch { /* an older server: none */ }
    if (h.queue.length)
        return { status: 200, items: take(h).map(({ id, body }) => ({ id, body })) };
    if (h.poller)
        h.poller([]); // a second poll replaces the first (a restarted server)
    const items = await new Promise((ok) => {
        const t = setTimeout(() => { if (h.poller === wake)
            h.poller = null; ok([]); }, holdMs);
        const wake = (w) => { clearTimeout(t); ok(w); };
        h.poller = wake;
    });
    h.lastPoll = Date.now();
    return { status: 200, items: items.map(({ id, body }) => ({ id, body })) };
}
/** A main server's answer to one envelope. */
export async function replyFrom(headers, body) {
    if (!relayOn())
        return 404;
    const s = await signedBy(headers, "reply", body);
    if (!s)
        return 401;
    let r;
    try {
        r = JSON.parse(body);
    }
    catch {
        return 400;
    }
    const w = typeof r.id === "string" ? s.h.inflight.get(r.id) : undefined;
    if (!w || typeof r.body !== "string" || r.body.length > MAX_REPLY)
        return 404;
    s.h.inflight.delete(w.id);
    w.done({ status: r.status === 200 ? 200 : 400, body: r.body });
    return 200;
}
/**
 * (1.58) The main server with this machine code, for the owner's remote access: its relay id and public key (what a
 * request is sealed with), and whether it is connected now. Neither is secret (they are in every phone's link code),
 * and neither opens anything: the server itself answers only requests sealed with one of the owner's keys. A server
 * could claim another's machine code here; it would gain nothing but the owner's sealed requests, which carry no
 * secret of another hospital's, and the owner's screen shows the name and code the server itself reports.
 */
export function findByMachine(machine) {
    const code = machine.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!relayOn() || code.length < 8)
        return null;
    let best = null;
    for (const e of hospitals)
        if (e[1].machine === code && (!best || e[1].lastPoll > best[1].lastPoll))
            best = e;
    return best ? { server: best[0], pub: best[1].pub, online: Date.now() - best[1].lastPoll < OFFLINE_AFTER_MS } : null;
}
/* ---------------- (1.60) the owner's list of installations ---------------- */
/**
 * The owner's keys, as the owner's signed control file names them: read from the releases site and checked against
 * the release key (releases.ts fetchControl), so a relay needs no setting of its own and nobody can add a key here.
 * Read again every ten minutes; kept when the site cannot be reached.
 */
let ownerKeysSource = async () => {
    const c = await fetchControl();
    return Array.isArray(c.ownerKeys) ? c.ownerKeys.filter((k) => typeof k === "string") : [];
};
let ownerKeysCache = null, ownerKeysKeepMs = 10 * 60_000;
/** (tests; a relay inside the whole app, app.ts: its own checked keys, read each time, keepMs 0) where the owner's keys come from */
export function setRelayOwnerKeysSource(f, keepMs = 10 * 60_000) { ownerKeysSource = f; ownerKeysCache = null; ownerKeysKeepMs = keepMs; }
/** The owner's keys; read again when kept too long, or (at most once a minute) when `want` is not among them yet. */
async function relayOwnerKeys(want, now = Date.now()) {
    const c = ownerKeysCache, age = c ? now - c.at : Infinity;
    if (c && age < ownerKeysKeepMs && (c.keys.includes(want) || age < 60_000))
        return c.keys;
    try {
        ownerKeysCache = { keys: await ownerKeysSource(), at: now };
    }
    catch {
        if (ownerKeysCache)
            ownerKeysCache.at = now;
    } // keep what it had; try again later
    return ownerKeysCache?.keys ?? null;
}
/** What the owner app signs to ask for the list (with the key it shares with the relay, relayMacKey). */
export const ownerListText = (t) => `hps-owner-list:${t}`;
/**
 * (1.60) Every installation this relay knows, for the owner app's control room: each main server's machine code (its
 * licence's), whether it is connected now, and when it last was. Only for a request from one of the owner's devices:
 * `pub` is a key the owner's signed control file names, and `mac` signs the time with the key only that device and
 * this relay can derive. Nothing else is given (no names, no addresses); the control room asks each installation
 * itself, sealed, how it is doing. Kept in memory: after a restart the list fills again as the servers poll.
 */
export async function ownerList(body, now = Date.now()) {
    if (!relayOn())
        return { status: 404, body: { error: "Not found" } };
    let r;
    try {
        r = JSON.parse(body);
    }
    catch {
        return { status: 400, body: { error: "Bad request" } };
    }
    const { pub, t, mac } = r;
    if (typeof pub !== "string" || typeof t !== "number" || typeof mac !== "string" || !/^[A-Za-z0-9_-]{86,88}$/.test(pub))
        return { status: 400, body: { error: "Bad request" } };
    if (Math.abs(now - t) > CLOCK_SKEW_MS)
        return { status: 401, body: { error: "The device's clock is off: set its time right", code: "clock" } };
    const keys = await relayOwnerKeys(pub, now);
    if (keys === null)
        return { status: 503, body: { error: "The relay cannot read the owner's control file right now", code: "control" } };
    if (!keys.includes(pub))
        return { status: 401, body: { error: "This device's key is not published", code: "refused" } };
    let ok = false;
    try {
        ok = await relayMacOk(await relayMacKey((await relayKey()).priv, pub), ownerListText(t), mac);
    }
    catch {
        ok = false;
    }
    if (!ok)
        return { status: 401, body: { error: "Refused", code: "refused" } };
    const best = new Map();
    for (const h of hospitals.values())
        if (h.machine && (!best.has(h.machine) || h.lastPoll > best.get(h.machine).lastPoll))
            best.set(h.machine, h);
    const installations = [...best.entries()].map(([machine, h]) => ({ machine, online: now - h.lastPoll < OFFLINE_AFTER_MS, lastSeen: new Date(h.lastPoll).toISOString() }))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return { status: 200, body: { installations } };
}
/** For the owner's screen: hospitals connected now. */
export const relayStatus = () => ({ on: relayOn(), hospitals: [...hospitals.values()].filter((h) => Date.now() - h.lastPoll < OFFLINE_AFTER_MS).length });
