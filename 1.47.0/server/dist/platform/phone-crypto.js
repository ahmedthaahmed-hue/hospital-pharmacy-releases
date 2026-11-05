// The phone app's end-to-end encryption (release 1.47, docs/PHONE.md). A phone reaches the main server only through
// the owner's relay over the internet; the relay passes sealed envelopes and can read none of them.
//
// Written against the Web Crypto API only (globalThis.crypto.subtle), so the phone app uses this same file.
//
//   Keys      ECDH P-256. The main server has one static key (S); each phone makes its own (P) when it is linked and
//             keeps it on the phone. The server's public key reaches the phone in the QR code on the PC's screen.
//   Request   the phone makes a fresh key (E) for each request. The AES-256-GCM key is HKDF-SHA256 over
//             ECDH(E, S) ‖ ECDH(P, S), salted with E: only this server can open it, and only a holder of P can have
//             sealed it (a stolen QR code or relay copy is not enough). The answer is sealed with a sister key.
//   AAD       the server's id and the phone's id (or, when linking, its public key): an envelope cannot be moved to
//             another server or passed off as another phone's.
//   Replay    the sealed request carries its own id and time; the server takes each id once, within two minutes.
const subtle = () => globalThis.crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = (b) => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = "";
    for (const c of u)
        s += String.fromCharCode(c);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64 = (s) => {
    const t = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) {
    out.set(p, o);
    o += p.length;
} return out; };
const bytes = (u) => u;
export async function newKeyPair(extractable = true) {
    return subtle().generateKey(ECDH, extractable, ["deriveBits"]);
}
/** A public key as text (raw, uncompressed point). */
export async function publicText(k) { return b64(await subtle().exportKey("raw", k)); }
export async function importPublic(text) { return subtle().importKey("raw", bytes(unb64(text)), ECDH, true, []); }
export async function privateText(k) { return b64(await subtle().exportKey("pkcs8", k)); }
export async function importPrivate(text) { return subtle().importKey("pkcs8", bytes(unb64(text)), ECDH, false, ["deriveBits"]); }
/** A server's id: the start of its public key's SHA-256 (what a phone asks the relay for). */
export async function serverIdOf(pub) { return b64(await subtle().digest("SHA-256", bytes(unb64(pub)))).slice(0, 22); }
/** The code both screens show while a phone is being linked: the start of the phone key's SHA-256, `AB12 CD34`. */
export async function phoneCode(pub) {
    const h = new Uint8Array(await subtle().digest("SHA-256", bytes(unb64(pub))));
    const hex = Array.from(h.slice(0, 4), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
    return `${hex.slice(0, 4)} ${hex.slice(4)}`;
}
const ecdh = async (priv, pub) => new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, priv, 256));
async function aesKey(shared, salt, info) {
    const ikm = await subtle().importKey("raw", bytes(shared), "HKDF", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: enc.encode(info) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const aad = (e) => enc.encode(`hps-phone-v1|${e.s}|${e.d ?? ""}|${e.p ?? ""}`);
async function keysFor(shared, eph) {
    return { req: await aesKey(shared, eph, "hps-phone-v1 request"), res: await aesKey(shared, eph, "hps-phone-v1 answer") };
}
async function seal(key, plain, ad) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const c = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: bytes(ad) }, key, enc.encode(JSON.stringify(plain)));
    return { i: b64(iv), c: b64(c) };
}
async function open(key, i, c, ad) {
    const p = await subtle().decrypt({ name: "AES-GCM", iv: bytes(unb64(i)), additionalData: bytes(ad) }, key, bytes(unb64(c)));
    return JSON.parse(dec.decode(p));
}
/** The phone: seal a request for the server; `openAnswer` then opens the server's answer to it. */
export async function sealRequest(o) {
    const eph = await newKeyPair();
    const S = await importPublic(o.server.pub);
    const ephPub = unb64(await publicText(eph.publicKey));
    const keys = await keysFor(cat(await ecdh(eph.privateKey, S), await ecdh(o.phone.priv, S)), ephPub);
    const head = { v: 1, s: o.server.id, ...(o.deviceId ? { d: o.deviceId } : { p: o.phone.pub }) };
    const env = { ...head, e: b64(ephPub), ...(await seal(keys.req, o.body, aad(head))) };
    return { envelope: env, openAnswer: async (a) => open(keys.res, a.i, a.c, aad(head)) };
}
/**
 * The server: open a phone's request. `phonePub` gives a linked phone's public key from its id (null: not a linked
 * phone). Throws when the envelope is not for this server, not from that phone, or was changed on the way.
 */
export async function openRequest(o) {
    const env = o.env;
    if (env?.v !== 1 || env.s !== o.serverId || typeof env.e !== "string" || typeof env.i !== "string" || typeof env.c !== "string")
        throw new Error("not an envelope for this server");
    const pubText = env.d != null ? o.phonePub(env.d) : env.p;
    if (!pubText || (env.d != null && env.p))
        throw new Error("unknown phone");
    const P = await importPublic(pubText), E = await importPublic(env.e);
    const keys = await keysFor(cat(await ecdh(o.serverPriv, E), await ecdh(o.serverPriv, P)), unb64(env.e));
    const head = { s: env.s, d: env.d, p: env.p };
    const body = await open(keys.req, env.i, env.c, aad(head));
    return { body, phonePub: pubText, answer: async (plain) => ({ v: 1, ...(await seal(keys.res, plain, aad(head))) }) };
}
/** A link request's proof that the phone saw the QR code: HMAC-SHA256 of its public key under the code's secret. */
export async function linkProof(secret, phonePub) {
    const k = await subtle().importKey("raw", bytes(unb64(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64(await subtle().sign("HMAC", k, enc.encode(`hps-phone-link|${phonePub}`)));
}
export const linkCodeText = (c) => `HPS1:${b64(enc.encode(JSON.stringify(c)))}`;
export function parseLinkCode(text) {
    try {
        if (!text.startsWith("HPS1:"))
            return null;
        const c = JSON.parse(dec.decode(unb64(text.slice(5))));
        return ["r", "s", "k", "l", "x"].every((k) => typeof c[k] === "string" && c[k]) ? c : null;
    }
    catch {
        return null;
    }
}
/**
 * The key a main server signs its relay calls with, and the relay checks them with: HMAC-SHA256 under a key both
 * derive from ECDH of the server's key and the relay's (each side with its own private key). Only the server holding
 * the private key behind its id can collect that id's envelopes or answer them; nobody can claim another's id.
 */
export async function relayMacKey(ownPriv, otherPub) {
    const shared = await ecdh(ownPriv, await importPublic(otherPub));
    const ikm = await subtle().importKey("raw", bytes(shared), "HKDF", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("hps-relay-v1"), info: enc.encode("calls") }, ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
}
export async function relayMac(key, text) { return b64(await subtle().sign("HMAC", key, enc.encode(text))); }
export async function relayMacOk(key, text, mac) {
    try {
        return await subtle().verify("HMAC", key, bytes(unb64(mac)), enc.encode(text));
    }
    catch {
        return false;
    }
}
export async function sha256Text(text) { return b64(await subtle().digest("SHA-256", enc.encode(text))); }
