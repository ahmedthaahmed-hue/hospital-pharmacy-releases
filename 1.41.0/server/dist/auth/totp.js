// Two-step sign-in (release 1.8): time-based one-time codes (RFC 6238, the 6-digit codes of Google / Microsoft
// Authenticator and the like) and one-use recovery codes. Secrets are base32, 20 random bytes; codes are HMAC-SHA1
// over 30-second steps, accepted one step either side for clock drift, and a step once used is not accepted again.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf) {
    let bits = 0, value = 0, out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += B32[(value << (5 - bits)) & 31];
    return out;
}
export function fromBase32(s) {
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0, value = 0;
    const out = [];
    for (const c of clean) {
        value = (value << 5) | B32.indexOf(c);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
export const newSecret = () => base32(randomBytes(20));
export const STEP_SECONDS = 30;
export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);
/** The 6-digit code of a step. */
export function codeAt(secret, step) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(step));
    const h = createHmac("sha1", fromBase32(secret)).update(msg).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1_000_000).padStart(6, "0");
}
/**
 * The step a code matches (now, one before or one after), or null. `after`: the last step already used — a code is
 * good once.
 */
export function matchCode(secret, code, nowMs, after) {
    const c = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(c))
        return null;
    const now = stepAt(nowMs);
    for (const s of [now, now - 1, now + 1]) {
        if (after != null && s <= after)
            continue;
        const want = Buffer.from(codeAt(secret, s)), got = Buffer.from(c);
        if (timingSafeEqual(want, got))
            return s;
    }
    return null;
}
/** What an authenticator app scans (shown as a QR code, or typed in by hand). */
export function otpauthUri(secret, account, issuer) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
/** Ten recovery codes (shown once) and their hashes (kept). */
export function newRecoveryCodes() {
    const codes = Array.from({ length: 10 }, () => {
        const s = base32(randomBytes(8)).slice(0, 10).toLowerCase();
        return `${s.slice(0, 5)}-${s.slice(5)}`;
    });
    return { codes, hashes: codes.map((c) => hashPassword(c)) };
}
/** The index of the recovery code that matches, or -1. */
export function matchRecovery(code, hashes) {
    const c = code.trim().toLowerCase().replace(/\s/g, "");
    if (!/^[a-z2-7]{5}-?[a-z2-7]{5}$/.test(c))
        return -1;
    const norm = c.includes("-") ? c : `${c.slice(0, 5)}-${c.slice(5)}`;
    return hashes.findIndex((h) => verifyPassword(norm, h));
}
