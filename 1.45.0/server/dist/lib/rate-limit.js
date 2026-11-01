// Slows down password guessing: after too many wrong passwords for one account from one address (or from one address
// overall) within the window, password checks from there are refused with 429 until the window passes. A correct
// password clears the account's count. In memory only: a restart forgets it, which is fine for a LAN app.
import { HttpError } from "./http.js";
const WINDOW_MS = 15 * 60_000;
const PER_ACCOUNT = 10; // wrong passwords for one username from one address
const PER_ADDRESS = 50; // wrong passwords from one address, any username
const buckets = new Map();
function bucket(key, now) {
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + WINDOW_MS };
        buckets.set(key, b);
    }
    return b;
}
function sweep(now) {
    if (buckets.size < 5000)
        return;
    for (const [k, b] of buckets)
        if (b.resetAt <= now)
            buckets.delete(k);
}
const keys = (scope, ip, username) => [`${scope}|${ip}|${username.trim().toLowerCase()}`, `${scope}|${ip}`];
/** Throws 429 when this address has guessed too often (for this account, or overall). Call before checking a password. */
export function assertNotThrottled(scope, ip, username) {
    const now = Date.now();
    // Only look: creating a bucket here for every name tried would let a throttled address grow the map without limit
    // (a fresh made-up username per request) — it is swept only when a failure is recorded.
    const [acct, addr] = keys(scope, ip, username).map((k) => { const b = buckets.get(k); return b && b.resetAt > now ? b : null; });
    const hit = acct && acct.count >= PER_ACCOUNT ? acct : addr && addr.count >= PER_ADDRESS ? addr : null;
    if (hit) {
        const min = Math.max(1, Math.ceil((hit.resetAt - now) / 60_000));
        throw new HttpError(429, `Too many wrong passwords — try again in ${min} minute${min === 1 ? "" : "s"}`);
    }
}
/** Record a wrong password. */
export function noteFailure(scope, ip, username) {
    const now = Date.now();
    sweep(now);
    for (const k of keys(scope, ip, username))
        bucket(k, now).count++;
}
/** A correct password: forget this account's wrong guesses from this address. */
export function noteSuccess(scope, ip, username) {
    buckets.delete(keys(scope, ip, username)[0]);
}
/** Tests only. */
export function resetRateLimits() { buckets.clear(); }
/** Tests only. */
export const rateLimitEntries = () => buckets.size;
/** Check a password with throttling: throws 429 when throttled, records the outcome, returns whether it matched. */
export function throttledCheck(scope, ip, username, check) {
    assertNotThrottled(scope, ip, username);
    const ok = check();
    if (ok)
        noteSuccess(scope, ip, username);
    else
        noteFailure(scope, ip, username);
    return ok;
}
