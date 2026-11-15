import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
export function hashPassword(pw) {
    const salt = randomBytes(16);
    const hash = scryptSync(pw, salt, 64);
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
    const [alg, saltHex, hashHex] = String(stored ?? "").split("$");
    if (alg !== "scrypt" || !saltHex || !hashHex)
        return false;
    const want = Buffer.from(hashHex, "hex");
    if (want.length !== 64)
        return false; // a damaged hash: timingSafeEqual would throw (a 500) on the length
    return timingSafeEqual(scryptSync(pw, Buffer.from(saltHex, "hex"), 64), want);
}
/**
 * A hash no password matches. Checked when the username does not exist (or has no usable hash), so that answer takes as
 * long as a wrong password and the time taken does not tell which usernames exist.
 */
let decoy = null;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(16).toString("hex")));
/** verifyPassword that spends the same time whether or not there is a user to check against. */
export function checkUserPassword(pw, stored) {
    const usable = typeof stored === "string" && stored.startsWith("scrypt$");
    const ok = verifyPassword(pw, usable ? stored : decoyHash());
    return usable && ok;
}
