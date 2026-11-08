// The phone app's side of the protocol (release 1.48, docs/PHONE.md): linking from the PC's QR code and sending sealed
// requests through the relay. Web Crypto and fetch only, so the phone app (web/src/phone) and the tests use this same
// file: what is tested against the real relay and main server is what runs on the phone.
import { b64, linkProof, newKeyPair, parseLinkCode, phoneCode, publicText, sealRequest, serverIdOf } from "./phone-crypto.js";
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
        body: { ...body, id: rid(), at: Date.now() + (id.clockOffset ?? 0) } });
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
