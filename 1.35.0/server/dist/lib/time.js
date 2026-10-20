// All timestamps are stored as LOCAL wall-clock time (the hospital's timezone), no offset:
//   datetime 'YYYY-MM-DDTHH:MM:SS', date 'YYYY-MM-DD', time 'HH:MM'.
// The server is expected to run with TZ set to the hospital zone (e.g. Africa/Cairo).
import { now, newRunId } from "../platform/clock.js";
export { now, newRunId };
const pad = (n) => String(n).padStart(2, "0");
export function toLocalIso(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function toLocalDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function toHHMM(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Parse 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SS]' as local time. */
export function parseLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (!m)
        throw new Error(`Bad local datetime: ${s}`);
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
}
/** Combine a 'YYYY-MM-DD' and 'HH:MM' into a Date. */
export function at(date, hhmm) {
    const [h, m] = (hhmm || "06:00").split(":").map(Number);
    const d = parseLocal(date);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
}
export function addHours(d, h) {
    return new Date(d.getTime() + h * 3_600_000);
}
export function addDays(d, days) {
    const r = new Date(d);
    r.setDate(r.getDate() + days);
    return r;
}
export function nowIso() {
    return toLocalIso(now());
}
/** Slot key used for idempotency: minute precision. */
export function slotKey(d) {
    return toLocalIso(d).slice(0, 16);
}
