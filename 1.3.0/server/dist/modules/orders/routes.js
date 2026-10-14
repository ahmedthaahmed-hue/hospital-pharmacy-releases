import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, notFound, parse, requirePerm, zDate, zId, zOptStr, zTime } from "../../lib/http.js";
import { addHours, nowIso, slotKey, toLocalDate, toLocalIso, now as clockNow } from "../../lib/time.js";
import { anchorOf, endOf, isSingleDose, labelTimes, medicalDay, normHHMM, planForWindow, totalDailyQty } from "../../core/schedule.js";
import { dispensedSlotBatches, medicationLabels, ORDER_SELECT } from "../../core/labels.js";
import { patientInLocation } from "../patients/scope.js";
import { itemsDispensedTodayElsewhere, loadOrderRows, markEditedAfterDispense, ordersWithSchedule, recordEditAfterDispense, regularTypes, scheduleChanged, scheduleSettings, } from "./view.js";
// upper bound: same limit as order-template lines; beyond it the schedule maths produce Infinity / invalid dates
const num = (msg, max = 100000) => z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number({ message: msg }).finite(msg).max(max, `${msg.replace(/ must be a number$/, "")} is too large`).nullable());
const orderFields = {
    itemId: z.string().trim().min(1, "Choose the item"),
    secItemId: zOptStr,
    dose: zOptStr,
    // at least every 5 minutes: shorter intervals round to duplicate dose times
    frequencyHours: num("Frequency must be a number").refine((v) => v == null || v > 0, "Frequency must be greater than zero")
        .refine((v) => v == null || v >= 1 / 12, "Frequency must be at least every 5 minutes"),
    dripRate: num("Drip rate must be a number").refine((v) => v == null || v >= 0, "Drip rate cannot be negative"),
    qtyPerDose: num("Qty per dose must be a number").refine((v) => v == null || v > 0, "Qty per dose must be greater than zero")
        // quantities are kept to 3 decimals: a smaller dose cannot be dispensed as whole doses (runs dispensed 0.001 for 2 doses)
        .refine((v) => v == null || !(v > 0) || v >= 0.001, "Qty per dose must be at least 0.001"),
    route: zOptStr,
    orderType: z.string().trim().min(1, "Choose the order type"),
    startDate: zDate,
    firstDoseTime: zTime.transform(normHHMM).refine((v) => { const [h, m] = v.split(":").map(Number); return h < 24 && m < 60; }, "Invalid time"),
    durationDays: num("Duration must be a number").refine((v) => v == null || v >= 0, "Duration cannot be negative"),
    status: z.enum(["active", "hold", "stopped"], { message: "Invalid status" }),
    notes: zOptStr,
};
const createSchema = z.object({
    ...orderFields,
    patientId: z.string().trim().min(1),
    startDate: orderFields.startDate.optional(),
    firstDoseTime: orderFields.firstDoseTime.optional(),
    status: orderFields.status.optional(),
    orderType: orderFields.orderType.optional(),
    qtyPerDose: orderFields.qtyPerDose.optional(),
}).partial({ secItemId: true, dose: true, frequencyHours: true, dripRate: true, route: true, durationDays: true, notes: true });
const updateSchema = z.object(orderFields).partial();
function orderRow(d, id, locationId) {
    const row = d.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
    if (!row || row.patient_location_id !== locationId)
        throw notFound("Order");
    return row;
}
function assertItem(d, id, what = "Item") {
    if (!d.get("SELECT 1 FROM items WHERE id = ?", [id]))
        throw bad(`${what} not found`);
}
function assertOrderType(d, code) {
    if (!d.get("SELECT 1 FROM order_types WHERE code = ?", [code]))
        throw bad("Invalid order type");
}
/** Next display order within the order's list (regular vs non-regular), legacy Form_BeforeInsert DMax+1. */
function nextDisplayOrder(d, patientId, isRegular) {
    const r = d.get(`SELECT MAX(o.display_order) m FROM medication_orders o JOIN order_types t ON t.code = o.order_type
     WHERE o.patient_id = ? AND t.is_regular = ?`, [patientId, isRegular ? 1 : 0]);
    return (r?.m ?? 0) + 1;
}
/**
 * Legacy UpdateItemDefaultsIfEmpty: copy the order's notes/route/frequency/dose into the item defaults only where the
 * item's default is empty. Never overwrites an existing default.
 */
function learnItemDefaults(d, o) {
    d.run(`UPDATE items SET
       default_notes = CASE WHEN IFNULL(TRIM(default_notes),'') = '' AND ? IS NOT NULL THEN ? ELSE default_notes END,
       default_route = CASE WHEN IFNULL(TRIM(default_route),'') = '' AND ? IS NOT NULL THEN ? ELSE default_route END,
       default_frequency = CASE WHEN default_frequency IS NULL AND ? IS NOT NULL THEN ? ELSE default_frequency END,
       default_dose = CASE WHEN IFNULL(TRIM(default_dose),'') = '' AND ? IS NOT NULL THEN ? ELSE default_dose END
     WHERE id = ?`, [o.notes, o.notes, o.route, o.route, o.frequency_hours, o.frequency_hours, o.dose, o.dose, o.item_id]);
}
/** Legacy TotalDailyQuantity, fractional. Single-dose orders (Once / no frequency) = qty per dose. */
function tdq(orderType, qpd, freq) {
    return totalDailyQty(qpd, orderType === "once" ? null : freq);
}
/**
 * Drip bag volume in mL from a text dose: "500", "500 mL", "250ml", "100 cc", "500 مل", "1 L" / "1 لتر" (×1000),
 * "1,000 mL" (thousands separator), "0,5 L" (decimal comma — only when it cannot be a thousands group), Arabic-Indic
 * digits and separators (٠-٩, ٬ ٫). A number with an unknown or no unit is taken as mL.
 */
export function parseVolume(dose) {
    if (!dose)
        return null;
    const s = dose
        .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
        .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
        .replace(/٬/g, ",").replace(/٫/g, ".");
    const m = /^\s*(\d+(?:[.,]\d+)*)\s*([^\s\d.,]*)/.exec(s);
    if (!m)
        return null;
    let t = m[1];
    if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(t))
        t = t.replace(/,/g, ""); // 1,000 / 12,500.5
    else if (/^\d+,\d+$/.test(t))
        t = t.replace(",", "."); // 0,5 / 1,5 / 2,25
    else if (!/^\d+(\.\d+)?$/.test(t))
        t = /^\d+(?:[.,]\d+)?/.exec(t)[0].replace(",", "."); // odd mix: leading number
    const v = Number(t);
    if (!Number.isFinite(v))
        return null;
    const unit = m[2].toLowerCase();
    const litres = /^(l|lt|ltr|liters?|litres?|لتر|لترات|لترًا|لترا)$/.test(unit);
    return litres ? Math.round(v * 1000 * 1000) / 1000 : v;
}
/** Drip next-dispense time: bag volume (mL) / rate (mL/h) hours from now. Throws a 400 on bad input. */
export function dripNext(volumeMl, rateMlH, now = clockNow()) {
    if (volumeMl == null || !Number.isFinite(volumeMl) || volumeMl <= 0)
        throw bad("Enter the bag volume in mL (a number greater than zero)");
    if (rateMlH == null || !Number.isFinite(rateMlH) || rateMlH <= 0)
        throw bad("Enter the drip rate in mL/h (a number greater than zero)");
    const hours = volumeMl / rateMlH;
    if (hours > 24 * 30)
        throw bad("The resulting duration is longer than 30 days — check the volume and rate");
    return { hours: Math.round(hours * 100) / 100, nextDispenseAt: toLocalIso(addHours(now, hours)).slice(0, 16) };
}
/**
 * Duplicate therapy: the patient's active, not yet ended orders for the same item or the same active ingredient.
 * A warning for the pharmacist only — the order is still created.
 */
function duplicateTherapy(d, patientId, itemId, now = clockNow()) {
    const ai = d.get("SELECT NULLIF(TRIM(active_ingredient),'') ai FROM items WHERE id = ?", [itemId])?.ai ?? null;
    const rows = d.all(`SELECT o.*, COALESCE(i.selection_name, i.name) AS item_name, NULLIF(TRIM(i.active_ingredient),'') AS ai
     FROM medication_orders o JOIN items i ON i.id = o.item_id
     WHERE o.patient_id = ? AND o.status = 'active'
       AND (o.item_id = ? OR (? IS NOT NULL AND LOWER(TRIM(i.active_ingredient)) = LOWER(?)))
     ORDER BY o.id`, [patientId, itemId, ai, ai]);
    const dayStart = scheduleSettings(d).dayStart;
    // Once / operation-kit orders are one dose and stay 'active' after it: they count only until their medical day is over
    const live = (o) => {
        if ((o.order_type === "once" || o.order_type === "operation") && isSingleDose(o))
            return medicalDay(anchorOf(o), dayStart).end.getTime() > now.getTime();
        const e = endOf(o);
        return !e || e.getTime() > now.getTime();
    };
    const out = rows.filter(live).map((o) => o.item_id === itemId
        ? `The patient has another active order for the same item (${o.item_name}) — make sure it is not a duplicate`
        : `The patient has an active order with the same active ingredient ${o.ai} (${o.item_name}) — make sure it is not a duplicate`);
    return [...new Set(out)];
}
/**
 * One label per dose slot ('YYYY-MM-DDTHH:MM'). A dose already dispensed shows the batch it was dispensed from (printed
 * again from Label preview, e.g. after a failed print, it showed the next FEFO batch — another one once the dispense
 * emptied a batch); the others the next FEFO batch.
 */
function doseLabels(d, row, locationId, slots) {
    const given = dispensedSlotBatches(d, row.id, row.qty_per_dose > 0 ? row.qty_per_dose : 1, slots);
    return slots.flatMap((k) => medicationLabels(d, row, locationId, [k.slice(11, 16)], given.get(k)));
}
export default async function routes(app) {
    /** A patient's orders split into the two legacy lists, each ordered by display_order, with today's schedule. */
    app.get("/patient/:patientId", async (req) => {
        const d = db();
        const p = patientInLocation(d, req.params.patientId, req.ctx.locationId);
        const now = clockNow();
        const views = ordersWithSchedule(d, loadOrderRows(d, "o.patient_id = ?", [p.id]), now);
        const s = scheduleSettings(d);
        const w = medicalDay(now, s.dayStart);
        return {
            now: toLocalIso(now).slice(0, 16), window: { start: slotKey(w.start), end: slotKey(w.end) }, graceHours: s.grace,
            regular: views.filter((v) => v.isRegular), other: views.filter((v) => !v.isRegular),
        };
    });
    app.get("/:id", async (req) => {
        const d = db();
        const row = orderRow(d, parse(zId, req.params.id), req.ctx.locationId);
        return ordersWithSchedule(d, [row])[0];
    });
    app.post("/", async (req) => {
        requirePerm(req, "orders");
        const b = parse(createSchema, req.body);
        const d = db();
        const p = patientInLocation(d, b.patientId, req.ctx.locationId, { activeOnly: true });
        const orderType = b.orderType ?? "regular";
        assertOrderType(d, orderType);
        assertItem(d, b.itemId);
        if (b.secItemId)
            assertItem(d, b.secItemId, "Additional item");
        const qpd = b.qtyPerDose ?? 1;
        // a single dose has no frequency (legacy OrderType_AfterUpdate: "Once" clears Duration; a leftover item-default
        // frequency would otherwise print "every N hours" on the label)
        const freq = orderType === "once" ? null : b.frequencyHours ?? null;
        // legacy OrderType_AfterUpdate: "Once" clears Duration
        const duration = orderType === "once" ? null : b.durationDays || null;
        const isReg = regularTypes(d).has(orderType);
        const now = nowIso();
        const warnings = duplicateTherapy(d, p.id, b.itemId);
        // the patient already received this item today for an order that was deleted or stopped (an order deleted and entered
        // again, or replaced by a new one): today's doses of the new order are not dispensed again unasked — the run skips it
        // today and a mid-day dispense needs force, as after editing a dispensed order. From tomorrow it runs as usual.
        const givenToday = itemsDispensedTodayElsewhere(d, p.id, [b.itemId]);
        if (givenToday.size)
            warnings.push(`${givenToday.get(b.itemId)} was already dispensed today to this patient for an order that was deleted or stopped — today's doses of this order will need a confirmation before they are dispensed`);
        const id = d.tx(() => {
            const order = nextDisplayOrder(d, p.id, isReg);
            const r = d.run(`INSERT INTO medication_orders(patient_id,item_id,sec_item_id,dose,frequency_hours,drip_rate,qty_per_dose,total_daily_qty,route,
           order_type,start_date,first_dose_time,duration_days,status,notes,display_order,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [p.id, b.itemId, b.secItemId ?? null, b.dose ?? null, freq, b.dripRate ?? null, qpd, tdq(orderType, qpd, freq), b.route ?? null,
                orderType, b.startDate ?? toLocalDate(clockNow()), b.firstDoseTime ?? "06:00", duration, b.status ?? "active", b.notes ?? null,
                order, req.ctx.userId, now, now]);
            learnItemDefaults(d, { item_id: b.itemId, notes: b.notes ?? null, route: b.route ?? null, frequency_hours: freq, dose: b.dose ?? null });
            if (givenToday.size)
                markEditedAfterDispense(d, r.lastId, medicalDay(clockNow(), scheduleSettings(d).dayStart).label);
            return r.lastId;
        });
        audit(req, "order.create", "order", id, { patientId: p.id, itemId: b.itemId, orderType, ...(warnings.length ? { warnings } : {}) });
        const view = ordersWithSchedule(d, [orderRow(d, id, req.ctx.locationId)])[0];
        return warnings.length ? { ...view, warnings } : view;
    });
    /** Update any field (partial). Total daily quantity is recomputed; changing list class moves the order to the end of the new list. */
    const update = async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const id = parse(zId, req.params.id);
        const cur = orderRow(d, id, req.ctx.locationId);
        const b = parse(updateSchema, req.body);
        if (b.itemId)
            assertItem(d, b.itemId);
        if (b.secItemId)
            assertItem(d, b.secItemId, "Additional item");
        if (b.orderType)
            assertOrderType(d, b.orderType);
        const pick = (k, col) => (b[k] !== undefined ? b[k] : cur[col]);
        const next = {
            item_id: pick("itemId", "item_id"), sec_item_id: pick("secItemId", "sec_item_id"), dose: pick("dose", "dose"),
            frequency_hours: pick("frequencyHours", "frequency_hours"), drip_rate: pick("dripRate", "drip_rate"),
            qty_per_dose: (b.qtyPerDose ?? cur.qty_per_dose), route: pick("route", "route"),
            order_type: (b.orderType ?? cur.order_type), start_date: b.startDate ?? cur.start_date,
            first_dose_time: b.firstDoseTime ?? cur.first_dose_time, duration_days: pick("durationDays", "duration_days"),
            status: b.status ?? cur.status, notes: pick("notes", "notes"),
        };
        if (next.order_type === "once")
            next.duration_days = null;
        if (next.duration_days === 0)
            next.duration_days = null;
        const reg = regularTypes(d);
        let editedDays = [];
        d.tx(() => {
            let displayOrder = cur.display_order;
            if (reg.has(next.order_type) !== reg.has(cur.order_type))
                displayOrder = nextDisplayOrder(d, cur.patient_id, reg.has(next.order_type));
            d.run(`UPDATE medication_orders SET item_id=?, sec_item_id=?, dose=?, frequency_hours=?, drip_rate=?, qty_per_dose=?, total_daily_qty=?,
           route=?, order_type=?, start_date=?, first_dose_time=?, duration_days=?, status=?, notes=?, display_order=?, updated_at=? WHERE id=?`, [next.item_id, next.sec_item_id, next.dose, next.frequency_hours, next.drip_rate, next.qty_per_dose,
                tdq(next.order_type, next.qty_per_dose, next.frequency_hours), next.route, next.order_type, next.start_date, next.first_dose_time,
                next.duration_days, next.status, next.notes, displayOrder, nowIso(), id]);
            learnItemDefaults(d, next);
            // today's doses already dispensed under the old schedule: runs skip the order today, manual dispense needs force
            if (scheduleChanged(cur, next))
                editedDays = recordEditAfterDispense(d, id, clockNow(), next, cur);
        });
        audit(req, "order.update", "order", id, editedDays.length ? { ...b, editedAfterDispense: editedDays } : b);
        return ordersWithSchedule(d, [orderRow(d, id, req.ctx.locationId)])[0];
    };
    app.put("/:id", update);
    app.patch("/:id", update);
    app.delete("/:id", async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const id = parse(zId, req.params.id);
        const cur = orderRow(d, id, req.ctx.locationId);
        d.run("DELETE FROM medication_orders WHERE id = ?", [id]);
        audit(req, "order.delete", "order", id, { patientId: cur.patient_id, itemId: cur.item_id, orderType: cur.order_type });
        return { ok: true };
    });
    /** Swap with the neighbour in the same list (legacy btnMoveUp/Down). The list is renumbered 1..n first so ties can't stall. */
    app.post("/:id/move", async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const id = parse(zId, req.params.id);
        const { direction } = parse(z.object({ direction: z.enum(["up", "down"], { message: "Invalid direction" }) }), req.body);
        const cur = orderRow(d, id, req.ctx.locationId);
        const isReg = regularTypes(d).has(cur.order_type);
        const moved = d.tx(() => {
            const list = d.all(`SELECT o.id FROM medication_orders o JOIN order_types t ON t.code = o.order_type
         WHERE o.patient_id = ? AND t.is_regular = ? ORDER BY o.display_order, o.id`, [cur.patient_id, isReg ? 1 : 0]).map((r) => r.id);
            const i = list.indexOf(id);
            const j = direction === "up" ? i - 1 : i + 1;
            if (i < 0 || j < 0 || j >= list.length)
                return false;
            [list[i], list[j]] = [list[j], list[i]];
            list.forEach((oid, k) => d.run("UPDATE medication_orders SET display_order = ? WHERE id = ?", [k + 1, oid]));
            return true;
        });
        if (moved)
            audit(req, "order.move", "order", id, { direction });
        return { ok: true, moved };
    });
    /**
     * Alphabetical renumbering of a patient's lists (legacy admin utilities Module2.InitializeDisplayOrderByItemName /
     * Module7.InitializeDripDisplayOrder, which ran for every active patient). Here it is a per-patient action:
     * display_order = 1..n by the name shown in the list (selection name, else item name), ties by order id,
     * separately for the regular and the non-regular list. list = regular | other | both (default).
     */
    app.post("/patient/:patientId/renumber", async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const p = patientInLocation(d, req.params.patientId, req.ctx.locationId);
        const { list } = parse(z.object({ list: z.enum(["regular", "other", "both"], { message: "Invalid list" }).default("both") }), req.body ?? {});
        const classes = list === "both" ? [1, 0] : list === "regular" ? [1] : [0];
        const changed = d.tx(() => {
            let n = 0;
            for (const isReg of classes) {
                const rows = d.all(`SELECT o.id, o.display_order FROM medication_orders o JOIN order_types t ON t.code = o.order_type JOIN items i ON i.id = o.item_id
           WHERE o.patient_id = ? AND t.is_regular = ?
           ORDER BY COALESCE(NULLIF(TRIM(i.selection_name), ''), i.name) COLLATE NOCASE, o.id`, [p.id, isReg]);
                rows.forEach((r, k) => {
                    if (r.display_order !== k + 1) {
                        d.run("UPDATE medication_orders SET display_order = ? WHERE id = ?", [k + 1, r.id]);
                        n++;
                    }
                });
            }
            return n;
        });
        audit(req, "order.renumber_alpha", "patient", p.id, { list, changed });
        return { ok: true, changed };
    });
    app.post("/:id/status", async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const id = parse(zId, req.params.id);
        const { status } = parse(z.object({ status: orderFields.status }), req.body);
        const cur = orderRow(d, id, req.ctx.locationId);
        if (cur.status !== status) {
            d.run("UPDATE medication_orders SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
            audit(req, "order.status", "order", id, { from: cur.status, to: status });
        }
        return ordersWithSchedule(d, [orderRow(d, id, req.ctx.locationId)])[0];
    });
    /**
     * Label preview for the doses still remaining today (legacy cmdPrintLabel_Click). No dispense.
     * Non-regular continuous drips print one drip label without a dose time.
     */
    app.get("/:id/labels", async (req) => {
        const d = db();
        const id = parse(zId, req.params.id);
        const row = orderRow(d, id, req.ctx.locationId);
        const view = ordersWithSchedule(d, [row])[0];
        const kind = row.order_type === "cont_drip" ? "drip" : "medication";
        if (row.status !== "active")
            return { kind, times: [], labels: [], message: view.schedule.stateText || "Order is not active" };
        const times = kind === "drip" ? [null] : view.schedule.remaining.map((k) => k.slice(11, 16));
        return {
            kind, times, labels: kind === "drip" ? medicationLabels(d, row, req.ctx.locationId, times) : doseLabels(d, row, req.ctx.locationId, view.schedule.remaining),
            message: times.length ? null : "No doses of this order remaining today",
        };
    });
    /** All label copies of the medical day (used when no dose remains, legacy prints every copy). */
    app.get("/:id/labels/day", async (req) => {
        const d = db();
        const row = orderRow(d, parse(zId, req.params.id), req.ctx.locationId);
        const kind = row.order_type === "cont_drip" ? "drip" : "medication";
        // same rule as /:id/labels: stopped / held orders are not labelled
        if (row.status !== "active")
            return { kind, times: [], labels: [], message: ordersWithSchedule(d, [row])[0].schedule.stateText || "Order is not active" };
        const s = scheduleSettings(d);
        const w = medicalDay(clockNow(), s.dayStart);
        const times = labelTimes({ ...row }, w);
        return { kind, times, labels: kind === "medication" && times.length
                ? doseLabels(d, row, req.ctx.locationId, planForWindow(row, w).slots.map(slotKey))
                : medicationLabels(d, row, req.ctx.locationId, times.length ? times : [null]) };
    });
    /**
     * Drip next-dispense calculator (legacy cmdTimer_Click): bag volume mL / rate mL/h → next_dispense_at.
     * volumeMl defaults to the numeric part of the order's dose, rateMlH to the order's drip rate. Saves the result.
     */
    app.post("/:id/drip-calc", async (req) => {
        requirePerm(req, "orders");
        const d = db();
        const id = parse(zId, req.params.id);
        const row = orderRow(d, id, req.ctx.locationId);
        const b = parse(z.object({
            volumeMl: num("Bag volume must be a number").optional(),
            rateMlH: num("Drip rate must be a number").optional(),
        }), req.body ?? {});
        const vol = b.volumeMl ?? parseVolume(row.dose);
        const rate = b.rateMlH ?? row.drip_rate;
        const r = dripNext(vol, rate);
        d.run("UPDATE medication_orders SET next_dispense_at = ?, drip_rate = ?, updated_at = ? WHERE id = ?", [r.nextDispenseAt, rate, nowIso(), id]);
        audit(req, "order.drip_calc", "order", id, { volumeMl: vol, rateMlH: rate, nextDispenseAt: r.nextDispenseAt });
        return { ...r, volumeMl: vol, rateMlH: rate };
    });
}
