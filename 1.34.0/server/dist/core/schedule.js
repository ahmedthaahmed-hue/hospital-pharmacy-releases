// Single schedule engine (legacy had two incompatible ones — FEATURES.md §5 #14).
// Canonical rules (kept from the legacy order screen, which pharmacists use daily):
//  * Doses are chained from the anchor = start_date + first_dose_time, every frequency_hours.
//  * The order ends at anchor + duration_days (exclusive). NULL duration = open-ended.
//  * The "medical day" is (06:00 today, 06:00 tomorrow] — a 06:00 dose belongs to the day that ends at it.
//  * "Remaining now" drops doses more than 3 h overdue (grace).
//  * Once orders and orders without a frequency have a single dose at the anchor.
//  * Only status 'active' orders are scheduled (legacy ignored Status — bug §5 #11).
import { addHours, at, parseLocal, toHHMM, toLocalDate, addDays, now as clockNow } from "../lib/time.js";
export const DAY_START = "06:00";
export const GRACE_HOURS = 3;
const MAX_SLOTS = 5000;
export function isSingleDose(o) {
    return o.order_type === "once" || !o.frequency_hours || o.frequency_hours <= 0;
}
/**
 * Continuous drip without a dose frequency: replaced when the bag runs out (drip next-dispense calculator, legacy
 * cmdTimer_Click), not on dose slots. It has no doses in a day and does not "end" after its start like a Once order.
 */
export function isOnDemandDrip(o) {
    return o.order_type === "cont_drip" && (!o.frequency_hours || o.frequency_hours <= 0);
}
export function anchorOf(o) {
    return at(o.start_date, o.first_dose_time || DAY_START);
}
/**
 * The written start (start date + first dose time) plus `h` hours in wall-clock terms. Chained from the written clock
 * time, not from the resolved anchor: an order written for 00:00 on the night the clocks go forward (Egypt, last Friday
 * of April: 00:00 → 01:00) resolves to 01:00, and chaining from that moved every later dose and the course end an hour
 * too (09:00, 17:00, …). Only a dose inside the skipped hour moves now.
 */
export function wallFromStart(o, h) {
    const d = parseLocal(String(o.start_date));
    const [hh, mm] = normHHMM(o.first_dose_time || DAY_START).split(":").map(Number);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 0, (mm || 0) + Math.round(h * 60), 0, 0);
}
/**
 * Wall-clock addition: 06:00 + 24 h is 06:00 the next day even across a DST change (Egypt observes DST).
 * Dose times are ward clock times, so the schedule is chained in local wall-clock time, not in absolute hours.
 */
export function addWallHours(d, h) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + Math.round(h * 60), d.getSeconds());
}
export function endOf(o) {
    // an on-demand drip has no dose slots but does run for its duration (planForWindow stops it there)
    if (isSingleDose(o) && !isOnDemandDrip(o))
        return null;
    if (o.duration_days == null || o.duration_days <= 0)
        return null;
    return wallFromStart(o, o.duration_days * 24);
}
/** Medical day containing `ref`: (dayStart, dayStart + 24h]. */
export function medicalDay(ref, dayStart = DAY_START) {
    let start = at(toLocalDate(ref), dayStart);
    if (ref.getTime() <= start.getTime())
        start = addDays(start, -1);
    const end = addDays(start, 1); // wall clock: (06:00, 06:00] even on a DST day
    return { start, end, label: toLocalDate(start) };
}
/** Medical day that begins on calendar date `date` (YYYY-MM-DD). */
export function medicalDayOf(date, dayStart = DAY_START) {
    const start = at(date, dayStart);
    return { start, end: addDays(start, 1), label: date };
}
/** Dose datetimes in (from, to]. */
export function slotsBetween(o, from, to) {
    const anchor = anchorOf(o);
    if (isSingleDose(o))
        return anchor > from && anchor <= to ? [anchor] : [];
    const f = o.frequency_hours * 3_600_000;
    const end = endOf(o);
    const out = [];
    // jump close to `from` instead of walking from the anchor; wall-clock and absolute time can differ by the DST hour, so
    // start an hour (plus one step) early — one step alone skips doses after the clocks go back when doses are < 1 h apart
    let k = Math.max(0, Math.floor((from.getTime() - anchor.getTime() - 3_600_000) / f) - 1);
    let last = -Infinity;
    for (let i = 0; i < MAX_SLOTS; i++, k++) {
        const t = wallFromStart(o, k * o.frequency_hours);
        if (end && t >= end)
            break;
        if (t > to)
            break;
        // a clock time in the hour skipped when the clocks go forward (Egypt: 00:00 → 01:00) resolves to the hour after it,
        // so doses less than an hour apart would repeat a dose time (q1h: 00:00 → 01:00, then 01:00) — one dose per time,
        // else the slot is counted twice and the run's dispensed-slot insert fails for the order
        if (t > from && t.getTime() > last)
            out.push(t);
        last = Math.max(last, t.getTime());
    }
    return out;
}
export const SKIP_TEXT = {
    not_active: "Order stopped",
    on_hold: "Order on hold",
    not_started: "Not started yet",
    ended: "Treatment duration ended",
    no_dose_today: "No dose on this day",
    no_selected_time: "No dose at the selected times",
    on_demand: "Continuous drip — dispensed when the bag runs out",
    changed_after_dispense: "Order edited after it was dispensed today — dispense manually if needed",
    unverified: "Not verified by a second pharmacist yet (Clinical → Verify orders)",
    already_dispensed: "These doses were already dispensed",
    out_of_stock: "Out of stock",
};
/**
 * What a 24h / selected-times run should do for an order in a medical day window.
 * selectedTimes: optional 'HH:MM' list; only slots at those clock times are kept.
 */
export function planForWindow(o, w, selectedTimes) {
    if (o.status === "stopped")
        return { slots: [], qty: 0, skip: "not_active" };
    if (o.status === "hold")
        return { slots: [], qty: 0, skip: "on_hold" };
    const anchor = anchorOf(o);
    if (isOnDemandDrip(o)) {
        if (anchor > w.end)
            return { slots: [], qty: 0, skip: "not_started", nextDose: anchor };
        const dripEnd = o.duration_days && o.duration_days > 0 ? wallFromStart(o, o.duration_days * 24) : null;
        if (dripEnd && dripEnd <= w.start)
            return { slots: [], qty: 0, skip: "ended", nextDose: null };
        return { slots: [], qty: 0, skip: "on_demand", nextDose: null };
    }
    const end = endOf(o);
    if (anchor > w.end)
        return { slots: [], qty: 0, skip: "not_started", nextDose: anchor };
    if (end && end <= w.start)
        return { slots: [], qty: 0, skip: "ended", nextDose: null };
    let slots = slotsBetween(o, w.start, w.end);
    if (slots.length === 0) {
        const next = nextDoseAfter(o, w.end);
        const ended = isSingleDose(o) ? anchor <= w.start : !!end && !next;
        return { slots, qty: 0, skip: ended ? "ended" : "no_dose_today", nextDose: next };
    }
    if (selectedTimes && selectedTimes.length) {
        const set = new Set(selectedTimes.map(normHHMM));
        slots = slots.filter((s) => set.has(toHHMM(s)));
        if (!slots.length)
            return { slots, qty: 0, skip: "no_selected_time" };
    }
    return { slots, qty: round3(slots.length * (o.qty_per_dose || 1)) };
}
/** Doses still to give in the current medical day (drops > grace hours overdue). */
export function remainingNow(o, now = clockNow(), grace = GRACE_HOURS, dayStart = DAY_START) {
    const w = medicalDay(now, dayStart);
    const plan = planForWindow(o, w);
    const cutoff = addHours(now, -grace);
    const remaining = plan.slots.filter((s) => s >= cutoff);
    const end = endOf(o);
    return {
        window: w,
        skip: plan.skip,
        slots: remaining,
        // no further dose on the chain before the end (looked up on the chain: the last dose may be one moved by the DST hour)
        lastDose: remaining.length > 0 && end
            ? slotsBetween(o, remaining[remaining.length - 1], addWallHours(remaining[remaining.length - 1], (o.frequency_hours ?? 0) + 2)).length === 0 : false,
        nextDose: remaining[0] ?? nextDoseAfter(o, now),
        qty: round3(remaining.length * (o.qty_per_dose || 1)),
    };
}
export function nextDoseAfter(o, ref) {
    if (o.status !== "active")
        return null;
    // not started yet: the next dose is the first one, however far ahead (the look-ahead below is only 48 h)
    const anchor = anchorOf(o);
    if (anchor > ref)
        return anchor;
    const s = slotsBetween(o, ref, addHours(ref, Math.max(48, (o.frequency_hours ?? 0) * 2)));
    return s[0] ?? null;
}
/** Label copies for one day: clock times of the doses in the medical day. */
export function labelTimes(o, w) {
    return planForWindow(o, w).slots.map(toHHMM);
}
/** Total quantity per 24 h (legacy TotalDailyQuantity, but fractional and with >24 h handled). */
export function totalDailyQty(qtyPerDose, freq) {
    if (qtyPerDose == null)
        return null;
    if (!freq || freq <= 0 || freq > 24)
        return round3(qtyPerDose);
    return round3(qtyPerDose * (24 / freq));
}
/** Up to 3 upcoming dose dates as 'd - d - d / m' (legacy CalcDispenseDaysCompact, month bug fixed). */
export function dispenseDaysCompact(o, from = clockNow()) {
    const days = [];
    const seen = new Set();
    const startOfToday = at(toLocalDate(from), "00:00");
    for (const s of slotsBetween(o, addHours(startOfToday, -0.001), addDays(startOfToday, 120))) {
        const k = toLocalDate(s);
        if (seen.has(k))
            continue;
        seen.add(k);
        days.push(s);
        if (days.length === 3)
            break;
    }
    if (!days.length)
        return "";
    const months = [...new Set(days.map((d) => d.getMonth() + 1))];
    if (months.length === 1)
        return `${days.map((d) => d.getDate()).join(" - ")} / ${months[0]}`;
    return days.map((d) => `${d.getDate()}/${d.getMonth() + 1}`).join(" - ");
}
/** Arabic AM/PM label: 'h ص' / 'h م', with legacy 12م (midnight) and 12ظ (noon). */
export function arabicDoseTime(hhmm) {
    const [h, m] = normHHMM(hhmm).split(":").map(Number);
    const mm = m ? `:${String(m).padStart(2, "0")}` : "";
    if (h === 0)
        return `12${mm}م`; // legacy: midnight shown as 12م
    if (h === 12)
        return `12${mm}ظ`;
    return h < 12 ? `${h}${mm} ص` : `${h - 12}${mm} م`;
}
export function normHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
    if (!m)
        return s;
    return `${m[1].padStart(2, "0")}:${m[2]}`;
}
export const round3 = (n) => Math.round(n * 1000) / 1000;
/**
 * Whole doses of `perDose` that `qty` covers. Quantities are dispensed to 3 decimals, so k doses are covered by
 * round3(k × perDose): a dose of 0.3333 dispensed as 0.333 is one dose (plain division counted 0, and every run gave it
 * again).
 */
export function dosesCovered(qty, perDose) {
    if (!(perDose > 0) || !(qty > 0))
        return 0;
    let n = Math.floor(qty / perDose + 1e-9);
    while (qty >= round3((n + 1) * perDose) - 1e-9)
        n++;
    return n;
}
/**
 * Start of a chained order whose written first dose time has already passed today: its next dose after `ref` on the
 * chain (start date + first dose time, every frequency hours; a frequency over a day steps a day at a time, so a q48h
 * order starts tomorrow instead of in two days). A fixed-length course started at a passed time lost its first dose.
 * Returns the written start unchanged when it is not in the past.
 */
export function nextChainStart(startDate, firstDoseTime, freqHours, ref) {
    const o = { start_date: startDate, first_dose_time: firstDoseTime };
    const step = Math.min(freqHours, 24);
    const minute = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), ref.getHours(), ref.getMinutes());
    for (let k = 0; k < MAX_SLOTS; k++) {
        const t = wallFromStart(o, k * step);
        if (t >= minute)
            return k === 0 ? { startDate, firstDoseTime: normHHMM(firstDoseTime) } : { startDate: toLocalDate(t), firstDoseTime: toHHMM(t) };
    }
    return { startDate, firstDoseTime };
}
