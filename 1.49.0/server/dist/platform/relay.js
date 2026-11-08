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
const MAX_WAITING = 50, MAX_BODY = 512 * 1024, CLOCK_SKEW_MS = 120_000;
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
        h = { queue: [], inflight: new Map(), poller: null, lastPoll: 0, macKey };
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
    if (!w || typeof r.body !== "string" || r.body.length > MAX_BODY)
        return 404;
    s.h.inflight.delete(w.id);
    w.done({ status: r.status === 200 ? 200 : 400, body: r.body });
    return 200;
}
/** For the owner's screen: hospitals connected now. */
export const relayStatus = () => ({ on: relayOn(), hospitals: [...hospitals.values()].filter((h) => Date.now() - h.lastPoll < OFFLINE_AFTER_MS).length });
