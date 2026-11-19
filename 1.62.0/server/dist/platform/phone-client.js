// The phone app's side of the protocol (release 1.48, docs/PHONE.md): linking from the PC's QR code and sending sealed
// requests through the relay. Web Crypto and fetch only, so the phone app (web/src/phone) and the tests use this same
// file: what is tested against the real relay and main server is what runs on the phone.
import { b64, linkProof, newKeyPair, parseLinkCode, phoneCode, publicText, relayMac, relayMacKey, sealRequest, serverIdOf } from "./phone-crypto.js";
/**
 * (1.50) The only requests a phone sends that are not GETs (platform/phone.ts phoneMayCall; the phone app refuses the
 * rest itself, lib/api.ts): messages, and the few that work something out and change nothing.
 */
export const PHONE_WRITES = [
    /^\/api\/chat\/(rooms\/\d+\/messages|read|heartbeat)$/,
    /^\/api\/runs\/preview$/, /^\/api\/stock\/fefo-plan$/, /^\/api\/orders\/\d+\/drip-calc$/,
    // (1.56) which pharmacy the phone looks at (the same rules as on a PC: auth/routes.ts /location); the phone's own
    /^\/api\/auth\/location$/,
];
export class PhoneError extends Error {
    code;
    status;
    constructor(code, message, status = 0) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
/** The link code in what the camera read: `HPS1:…`, or the phone app's address with `#HPS1:…` after it. */
export function linkCodeFrom(text) {
    let t = text.trim();
    try {
        t = decodeURIComponent(t);
    }
    catch { /* not encoded */ }
    const i = t.indexOf("HPS1:");
    return i < 0 ? null : parseLinkCode(t.slice(i));
}
const okRelay = (u) => {
    try {
        const p = new URL(u);
        return p.protocol === "https:" || (p.protocol === "http:" && /^(localhost|127\.|10\.|192\.168\.)/.test(p.hostname));
    }
    catch {
        return false;
    }
};
const RELAY_SAYS = {
    hospital_offline: "The hospital's main server is not connected to the internet right now",
    no_answer: "The hospital's main server did not answer in time: try again",
    busy: "The hospital's main server is busy: try again in a moment",
};
const rid = () => b64(globalThis.crypto.getRandomValues(new Uint8Array(12)));
async function send(id, body, f, retried = false) {
    const sealed = await sealRequest({ server: id.server, phone: { priv: id.priv, pub: id.pub }, deviceId: id.deviceId,
        body: { ...body, id: rid(), at: Date.now() + (id.clockOffset ?? 0), z: 1 } });
    let r;
    try {
        r = await f(`${id.relay}/api/relay/to/${encodeURIComponent(id.server.id)}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sealed.envelope), signal: AbortSignal.timeout(45_000)
        });
    }
    catch {
        throw new PhoneError("no_internet", "Cannot reach the hospital: check the phone's internet");
    }
    const json = await r.json().catch(() => null);
    if (r.status !== 200) {
        const code = String(json?.code ?? (r.status === 429 ? "too_many" : r.status === 404 ? "no_relay" : "relay"));
        throw new PhoneError(code, RELAY_SAYS[code] ?? (r.status === 429 ? "Too many tries: wait a minute" : r.status === 404 ? "The relay is not on" : "The relay refused the request"), r.status);
    }
    let a;
    try {
        a = await sealed.openAnswer(json);
    }
    catch {
        throw new PhoneError("refused", "The hospital refused the request", 400);
    }
    // the phone's clock is off: take the main server's time and send it again, once
    if (a.status === 400 && a.body?.code === "clock" && typeof a.body.now === "number" && !retried) {
        id.clockOffset = a.body.now - Date.now();
        return send(id, body, f, true);
    }
    return a;
}
/**
 * Link this phone with the code the PC shows: makes the phone's own key (it never leaves the phone) and sends the link
 * request. The PC then shows `identity.code`; this phone should show the same, and works once it is confirmed there.
 */
export async function claimLink(codeText, name, f = fetch) {
    const c = linkCodeFrom(codeText);
    if (!c || (await serverIdOf(c.k).catch(() => "")) !== c.s || !okRelay(c.r))
        throw new PhoneError("bad_code", "This is not a link code from the Hospital Pharmacy PC");
    const kp = await newKeyPair(false);
    const pub = await publicText(kp.publicKey);
    const id = { relay: new URL(c.r).origin, server: { id: c.s, pub: c.k }, priv: kp.privateKey, pub,
        name: name.trim().slice(0, 60) || "Phone", code: await phoneCode(pub) };
    const a = await send(id, { t: "link", link: c.l, proof: await linkProof(c.x, pub), name: id.name }, f);
    if (a.status !== 200)
        throw new PhoneError(String(a.body?.code ?? "refused"), String(a.body?.error ?? "Refused"), a.status);
    id.deviceId = Number(a.body.deviceId);
    return id;
}
/** One request to the main server's API, as this phone's user (only the phone's screens: platform/phone.ts). */
export function call(id, method, url, body, f = fetch) {
    if (!id.deviceId)
        return Promise.reject(new PhoneError("not_linked", "This phone is not linked"));
    return send(id, { t: "req", m: method, u: url, ...(body === undefined ? {} : { b: body }) }, f);
}
/**
 * (1.50) The hospital's name and logo, from a link code, before the phone is linked (an iPhone's app is added to the
 * home screen first: it then carries the hospital's logo). A throwaway key: nothing is linked by this.
 */
export async function brandFrom(codeText, f = fetch) {
    const c = linkCodeFrom(codeText);
    if (!c || (await serverIdOf(c.k).catch(() => "")) !== c.s || !okRelay(c.r))
        return null;
    const kp = await newKeyPair(false);
    const id = { relay: new URL(c.r).origin, server: { id: c.s, pub: c.k }, priv: kp.privateKey, pub: await publicText(kp.publicKey), name: "", code: "" };
    try {
        const a = await send(id, { t: "brand", link: c.l }, f);
        return a.status === 200 ? { name: a.body?.name ?? null, logo: typeof a.body?.logo === "string" ? a.body.logo : null } : null;
    }
    catch {
        return null;
    }
}
/* ---------------- (1.58) the owner's remote access (server platform/owner-remote.ts) ---------------- */
/** The main server with this machine code, as the owner's relay knows it. */
export async function ownerFind(relay, machine, f = fetch) {
    const code = machine.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (code.length < 8)
        throw new PhoneError("bad_code", "Enter the machine code shown on the main server (Admin → Updates → Licence)");
    let r;
    try {
        r = await f(`${new URL(relay).origin}/api/relay/find/${code}`, { signal: AbortSignal.timeout(20_000) });
    }
    catch {
        throw new PhoneError("no_internet", "Cannot reach the relay: check the internet");
    }
    const j = await r.json().catch(() => null);
    // (a relay from before 1.58 has no such address: it updates itself each night)
    if (r.status === 404 && j?.code !== "not_found")
        throw new PhoneError("old_relay", "The relay does not offer the owner's remote access yet: it updates itself within a day of version 1.58 being published", 404);
    if (r.status === 404)
        throw new PhoneError("not_found", "No main server with this machine code is connected (it must run version 1.58 or later and reach the internet)", 404);
    if (r.status !== 200 || typeof j?.server !== "string" || typeof j?.pub !== "string" || (await serverIdOf(j.pub).catch(() => "")) !== j.server)
        throw new PhoneError("relay", r.status === 429 ? "Too many tries: wait a minute" : "The relay refused the request", r.status);
    return { server: { id: j.server, pub: j.pub }, online: !!j.online };
}
/** A request as the system's owner (sealed with the owner's key; no method: which installation this is). */
export function ownerCall(id, method, url, body, f = fetch) {
    return send(id.deviceId ? { ...id, deviceId: undefined } : id, { t: "owner", ...(method ? { m: method, u: url } : {}), ...(body === undefined ? {} : { b: body }) }, f);
}
/**
 * (1.60) Every installation the owner's relay knows (machine code, connected now, last seen), for the control room.
 * Signed with the key this device shares with the relay (relay.ts ownerList); the relay answers only a published key.
 */
export async function ownerList(relay, key, f = fetch, now = Date.now()) {
    const origin = new URL(relay).origin;
    let r;
    try {
        const k = await f(`${origin}/api/relay/key`, { signal: AbortSignal.timeout(20_000) });
        const relayPub = (await k.json().catch(() => null))?.pub;
        if (k.status === 404 || typeof relayPub !== "string")
            throw new PhoneError("relay", "The relay is not answering");
        const mac = await relayMac(await relayMacKey(key.priv, relayPub), `hps-owner-list:${now}`);
        r = await f(`${origin}/api/relay/owner/list`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ pub: key.pub, t: now, mac }), signal: AbortSignal.timeout(20_000) });
    }
    catch (e) {
        if (e instanceof PhoneError)
            throw e;
        throw new PhoneError("no_internet", "Cannot reach the relay: check the internet");
    }
    const j = await r.json().catch(() => null);
    // (a relay from before 1.60 has no such address: it updates itself each night)
    if (r.status === 404)
        throw new PhoneError("old_relay", "The relay cannot list the installations yet: it updates itself within a day of version 1.60 being published", 404);
    if (r.status !== 200 || !Array.isArray(j?.installations))
        throw new PhoneError(j?.code ?? "relay", String(j?.error ?? `The relay answered ${r.status}`), r.status);
    return j.installations.filter((x) => typeof x?.machine === "string" && /^[0-9a-f]{8,64}$/.test(x.machine))
        .map((x) => ({ machine: x.machine, online: !!x.online, lastSeen: String(x.lastSeen ?? "") }));
}
/** A new key for the owner's device: made on it, never extractable. Its public half is what the owner publishes. */
export async function newOwnerKey() {
    const kp = await newKeyPair(false);
    return { priv: kp.privateKey, pub: await publicText(kp.publicKey) };
}
