import { ORDER_SELECT } from "../../core/labels.js";
import { DAY_START, GRACE_HOURS, SKIP_TEXT, anchorOf, endOf, isOnDemandDrip, isSingleDose, medicalDay, normHHMM, planForWindow, remainingNow, slotsBetween, round3, } from "../../core/schedule.js";
import { addHours, nowIso, parseLocal, slotKey, toLocalIso, now as clockNow } from "../../lib/time.js";
export function scheduleSettings(db) {
    const rows = db.all("SELECT key, value FROM settings WHERE key IN ('schedule.day_start','schedule.grace_hours')");
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const g = Number(m["schedule.grace_hours"]);
    const ds = /^\d{1,2}:\d{2}$/.test(m["schedule.day_start"] ?? "") ? m["schedule.day_start"] : DAY_START;
    return { dayStart: ds, grace: Number.isFinite(g) && g >= 0 ? g : GRACE_HOURS };
}
/** Regular vs non-regular split (order_types.is_regular). */
export function regularTypes(db) {
    return new Set(db.all("SELECT code FROM order_types WHERE is_regular = 1").map((r) => r.code));
}
export function loadOrderRows(db, where, params) {
    return db.all(`${ORDER_SELECT} WHERE ${where} ORDER BY o.display_order, o.id`, params);
}
/** Dispensed slot keys ('YYYY-MM-DDTHH:MM') per order within (from, to]. */
export function dispensedSlots(db, orderIds, from, to) {
    const out = new Map();
    if (!orderIds.length)
        return out;
    const rows = db.all(`SELECT order_id, slot_at FROM dispensed_slots WHERE order_id IN (${orderIds.map(() => "?").join(",")}) AND slot_at > ? AND slot_at <= ?`, [...orderIds, slotKey(from), slotKey(to)]);
    for (const r of rows) {
        if (!out.has(r.order_id))
            out.set(r.order_id, new Set());
        out.get(r.order_id).add(r.slot_at);
    }
    return out;
}
/**
 * Changing these after doses were dispensed breaks the "already dispensed" check (slots are keyed by order + dose time):
 * new dose times look undispensed, a new item looks dispensed. The start date moves the dose chain too (q16h, q48h).
 * So does an order type change into or out of Once (one dose at the start instead of the q-hour chain) or an on-demand
 * drip (no dose slots): a regular order dispensed for 16:00 and 00:00 that becomes Once has an undispensed 08:00 dose.
 */
export function scheduleChanged(cur, next) {
    const t = (v) => normHHMM(String(v ?? DAY_START));
    // a single dose has no chain: a frequency left on a Once order (legacy rows, an item default) moves no dose time
    const single = isSingleDose(next) && isSingleDose(cur) && isOnDemandDrip(next) === isOnDemandDrip(cur);
    return next.item_id !== cur.item_id || (!single && (next.frequency_hours ?? null) !== (cur.frequency_hours ?? null))
        || isSingleDose(next) !== isSingleDose(cur) || isOnDemandDrip(next) !== isOnDemandDrip(cur)
        || String(next.start_date ?? "").slice(0, 10) !== String(cur.start_date ?? "").slice(0, 10)
        || t(next.first_dose_time) !== t(cur.first_dose_time) || Math.abs((next.qty_per_dose ?? 0) - (cur.qty_per_dose ?? 0)) > 1e-9;
}
/**
 * Record a schedule-relevant edit for every medical day, from the current one on, that already has dispensed doses of
 * the order. Runs skip the order on those days and a manual dispense needs force (order_edits_after_dispense).
 */
export function recordEditAfterDispense(db, orderId, now = clockNow(), next, prev) {
    const s = scheduleSettings(db);
    const w = medicalDay(now, s.dayStart);
    const slots = db.all("SELECT slot_at FROM dispensed_slots WHERE order_id = ? AND slot_at > ?", [orderId, slotKey(w.start)]);
    const days = new Set(slots.map((r) => medicalDay(parseLocal(r.slot_at), s.dayStart).label));
    // a single-dose order (Once / operation / care) that was dispensed is still that one dose when it is moved: its new day
    // gets the mark too, or the run of that day dispensed the dose again (only days that already had slots were marked).
    // Only when it was a single dose before the edit too: the doses of a regular order were other doses, so a regular order
    // turned into a Once dose on a later day has nothing of that dose dispensed — marking the day made the run skip it.
    const single = (o) => isSingleDose(o) && !isOnDemandDrip(o);
    if (next && single(next) && (!prev || single(prev))
        && db.get("SELECT 1 FROM dispenses WHERE order_id = ? AND type <> 'return' UNION ALL SELECT 1 FROM dispensed_slots WHERE order_id = ?", [orderId, orderId])) {
        const day = medicalDay(anchorOf(next), s.dayStart).label;
        if (day >= w.label)
            days.add(day);
    }
    for (const day of days)
        markEditedAfterDispense(db, orderId, day);
    return [...days];
}
export function markEditedAfterDispense(db, orderId, day) {
    db.run("INSERT OR IGNORE INTO order_edits_after_dispense(order_id, medical_day, at) VALUES (?,?,?)", [orderId, day, nowIso()]);
}
/**
 * Items a patient already received today (run / selected-times / mid-day / drip) for orders that no longer stand: deleted
 * (dispenses.order_id cleared), stopped, or — with `alsoKit` — any order added by an operation kit. A new order for such
 * an item would otherwise be dispensed again by the next run (delete + re-create the same order, re-apply a kit).
 * A 24 h / selected-times run counts for the medical day it dispensed (a run for the day done the evening before or
 * before the day start dispensed today's doses at a time outside today); other dispenses count by when they happened.
 */
export function itemsDispensedTodayElsewhere(db, patientId, itemIds, opts = {}) {
    const out = new Map();
    if (!itemIds.length)
        return out;
    const w = medicalDay(opts.now ?? clockNow(), scheduleSettings(db).dayStart);
    const rows = db.all(`SELECT DISTINCT x.item_id, COALESCE(NULLIF(TRIM(i.selection_name),''), i.name) AS name
     FROM dispenses x JOIN items i ON i.id = x.item_id LEFT JOIN medication_orders o ON o.id = x.order_id
       LEFT JOIN dispense_runs r ON r.id = x.run_id AND x.type IN ('run_24h','selected_times')
     WHERE x.patient_id = ? AND x.type IN ('run_24h','selected_times','midday','drip')
       AND (CASE WHEN r.id IS NOT NULL THEN json_extract(r.summary, '$.window.label') = ? ELSE x.at > ? AND x.at <= ? END)
       AND x.item_id IN (${itemIds.map(() => "?").join(",")})
       AND (x.order_id IS NULL OR o.status = 'stopped'${opts.alsoKit ? " OR o.is_auto_from_operation = 1" : ""})`, [patientId, w.label, toLocalIso(w.start), toLocalIso(w.end), ...itemIds]);
    for (const r of rows)
        out.set(r.item_id, r.name);
    return out;
}
/** Orders edited (schedule-relevant) after doses of medical day `day` were dispensed. */
export function editedAfterDispense(db, day, orderId) {
    const rows = db.all(`SELECT order_id FROM order_edits_after_dispense WHERE medical_day = ?${orderId ? " AND order_id = ?" : ""}`, orderId ? [day, orderId] : [day]);
    return new Set(rows.map((r) => r.order_id));
}
const STATE_TEXT = {
    active: "", hold: SKIP_TEXT.on_hold, stopped: SKIP_TEXT.not_active, not_started: SKIP_TEXT.not_started,
    ended: SKIP_TEXT.ended, no_dose_today: SKIP_TEXT.no_dose_today, on_demand: SKIP_TEXT.on_demand,
};
export function schedOf(row) {
    return {
        order_type: row.order_type, start_date: row.start_date, first_dose_time: row.first_dose_time,
        frequency_hours: row.frequency_hours, duration_days: row.duration_days, status: row.status, qty_per_dose: row.qty_per_dose,
    };
}
/**
 * Today's schedule for one order.
 *  - slots: every dose of the current medical day with a display state (the dose-timeline strip)
 *  - remaining: legacy CalculateRemainingDoses (future doses + doses ≤ grace hours overdue)
 *  - toDispense: remaining doses not yet covered by a dispense (dispensed_slots)
 */
export function scheduleInfo(row, now, s, dispensed = new Set()) {
    const o = schedOf(row);
    const rem = remainingNow(o, now, s.grace, s.dayStart);
    const w = rem.window;
    const cutoff = addHours(now, -s.grace);
    let state;
    if (o.status === "stopped")
        state = "stopped";
    else if (o.status === "hold")
        state = "hold";
    else if (rem.skip === "not_started")
        state = "not_started";
    else if (rem.skip === "ended")
        state = "ended";
    else if (rem.skip === "no_dose_today")
        state = "no_dose_today";
    else if (rem.skip === "on_demand")
        state = "on_demand";
    else
        state = "active";
    let slots;
    if (o.status !== "active") {
        // ghost pips: what the day would look like, so a held order is still readable
        slots = slotsBetween({ ...o, status: "active" }, w.start, w.end).map((t) => ({ at: slotKey(t), state: "inactive" }));
    }
    else {
        slots = planForWindow(o, w).slots.map((t) => {
            const k = slotKey(t);
            const st = dispensed.has(k) ? "dispensed" : t > now ? "upcoming" : t >= cutoff ? "due" : "missed";
            return { at: k, state: st };
        });
    }
    const remaining = rem.slots.map(slotKey);
    const toDispense = remaining.filter((k) => !dispensed.has(k));
    const qpd = row.qty_per_dose || 1;
    const end = endOf(o);
    return {
        state, stateText: STATE_TEXT[state],
        window: { start: slotKey(w.start), end: slotKey(w.end) },
        slots, remaining, remainingCount: remaining.length, remainingQty: round3(remaining.length * qpd),
        toDispense, toDispenseQty: round3(toDispense.length * qpd), dispensedCount: slots.filter((x) => x.state === "dispensed").length,
        nextDose: rem.nextDose ? slotKey(rem.nextDose) : null, lastDose: rem.lastDose, endsAt: end ? slotKey(end) : null,
    };
}
export function orderView(row, regular, sched) {
    return {
        id: row.id, patientId: row.patient_id, itemId: row.item_id, itemName: row.item_name, unit: row.unit ?? null,
        highAlert: !!row.item_high_alert, tallManName: row.item_tall_man ?? null, doubleCheckedBy: row.double_checked_by ?? null,
        secItemId: row.sec_item_id, secItemName: row.sec_item_name ?? null, dose: row.dose, frequencyHours: row.frequency_hours,
        dripRate: row.drip_rate, qtyPerDose: row.qty_per_dose, totalDailyQty: row.total_daily_qty, route: row.route,
        orderType: row.order_type, isRegular: regular.has(row.order_type), startDate: row.start_date, firstDoseTime: row.first_dose_time,
        durationDays: row.duration_days, status: row.status, notes: row.notes, nextDispenseAt: row.next_dispense_at,
        displayOrder: row.display_order, isAutoFromOperation: !!row.is_auto_from_operation, createdAt: row.created_at, updatedAt: row.updated_at,
        verified: row.verified_at != null,
        schedule: sched ?? null,
    };
}
/** Rows → views with schedule, one dispensed_slots query for the lot. */
export function ordersWithSchedule(db, rows, now = clockNow()) {
    const s = scheduleSettings(db);
    const reg = regularTypes(db);
    const w = medicalDay(now, s.dayStart);
    const disp = dispensedSlots(db, rows.map((r) => r.id), w.start, w.end);
    return rows.map((r) => orderView(r, reg, scheduleInfo(r, now, s, disp.get(r.id))));
}
