// Ward dispensing from the workspace: mid-day / drip print & dispense of an order, manual dispense, returns.
// Legacy: subfrmSimpleMedicationOrders.Command24_Click, subfrmDripMedicationOrders.cmdPrintLabel_Click, frmSimpleDispense,
// frmSimpleReturns + frmReturnBatchPrompt. Fixes:
//  * availability = what FEFO can dispense (non-expired) — legacy counted expired stock (§5 #10)
//  * decimal quantities (§5 #9)
//  * stopped / held orders are not dispensed (§5 #11)
//  * idempotency: dispensed dose slots are recorded in dispensed_slots so the 24h run and a second mid-day click
//    do not dispense the same doses again (§5 #8); a deliberate extra dispense needs force=true
//  * returns are atomic, cannot go into a TEMP (placeholder) batch, and warn when exceeding what the patient received (§2.15)
import { verificationMode } from "../clinical/schema.js";
import { z } from "zod";
import { db } from "../../db/index.js";
import { HttpError, audit, notFound, parse, requirePerm, zDate, zId, zOptStr } from "../../lib/http.js";
import { addHours, nowIso, slotKey, toLocalIso, now as clockNow } from "../../lib/time.js";
import { available, batchAt, dispenseFEFO, lastDispensedBatch, returnToStock, stockSummary } from "../../core/fefo.js";
import { medicationLabels, nextBatch, ORDER_SELECT } from "../../core/labels.js";
import { anchorOf, isOnDemandDrip, isSingleDose, labelTimes, medicalDay, planForWindow, round3 } from "../../core/schedule.js";
import { patientInLocation } from "../patients/scope.js";
import { dispensedSlots, editedAfterDispense, regularTypes, scheduleInfo, scheduleSettings, schedOf } from "../orders/view.js";
import { parseVolume } from "../orders/routes.js";
import { checkScan } from "../../core/scan.js";
import { gateSafety, logSafety, safetyAlerts, zSafetyAck } from "../../core/safety.js";
const zQty = z.preprocess((v) => (v === "" || v == null ? NaN : Number(v)), z.number({ message: "Quantity must be a number" }).refine((n) => Number.isFinite(n) && n > 0, "Quantity must be greater than zero")
    // stock is kept to 3 decimals: a smaller quantity rounds to 0 (a return then failed with a 500, a dispense did nothing)
    .refine((n) => !(n > 0) || round3(n) > 0, "Quantity must be at least 0.001")
    .refine((n) => n <= 1_000_000, "Quantity is too large")); // a huge return would put Infinity into stock
function item(d, id) {
    const i = d.get("SELECT id, name, selection_name, unit, use_window, active_ingredient, strength, strength_unit, special FROM items WHERE id = ?", [id]);
    if (!i)
        throw notFound("Item");
    return i;
}
function stockOf(d, itemId, locationId) {
    const s = stockSummary(d, itemId, locationId);
    return { available: available(d, itemId, locationId), usable: round3(s.usable), expired: round3(s.expired), placeholder: round3(s.placeholder) };
}
function orderRow(d, id, locationId) {
    const row = d.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
    if (!row || row.patient_location_id !== locationId)
        throw notFound("Order");
    return row;
}
/** What a mid-day / drip print & dispense would do right now. */
function planFor(d, row, locationId, now = clockNow()) {
    const s = scheduleSettings(d);
    const w = medicalDay(now, s.dayStart);
    const sched = scheduleInfo(row, now, s, dispensedSlots(d, [row.id], w.start, w.end).get(row.id));
    const isDrip = row.order_type === "cont_drip";
    const isRegular = regularTypes(d).has(row.order_type);
    const qpd = row.qty_per_dose > 0 ? row.qty_per_dose : 1;
    // legacy: regular = QPD × remaining doses (min 1 dose); non-regular (drip form) = QPD
    const doses = isRegular ? Math.max(sched.toDispense.length, 1) : 1;
    let forceReason = null;
    // dose slots this dispense records (whole doses covered by the quantity): the remaining ones first, then today's doses
    // already more than the grace period overdue and never dispensed — a Once dose dispensed at 14:00 for 08:00 is that
    // dose, so a later run of the day must not dispense it again
    let toRecord = [...sched.toDispense, ...sched.slots.filter((x) => x.state === "missed").map((x) => x.at)];
    const o = schedOf(row);
    const anchor = anchorOf(o);
    let editDay = w.label; // the medical day this dispense counts for
    if (!isOnDemandDrip(o) && row.status === "active" && anchor > w.end) {
        // dispensed before the medical day of its first dose: it counts as the first dose(s) — the single dose of a Once /
        // operation / care order, the first doses of a regular order, the first bags of a drip with a frequency — so the run
        // on the start date does not dispense them again (a regular order dispensed early used to record no slot, and the
        // run gave its first doses again); like any dispense outside the order's days it needs force
        const startDay = medicalDay(anchor, s.dayStart);
        const taken = dispensedSlots(d, [row.id], startDay.start, startDay.end).get(row.id) ?? new Set();
        const first = planForWindow(o, startDay).slots.map(slotKey).filter((k) => !taken.has(k));
        forceReason = first.length ? `The order starts on ${row.start_date} at ${slotKey(anchor).slice(11, 16)} — dispense early?`
            : isSingleDose(o) ? "A dose of this order was already dispensed before its start time"
                : "The first day's doses of this order were already dispensed before its start time";
        toRecord = first;
        editDay = startDay.label;
    }
    else if (isDrip) {
        // a drip with a dose frequency: the run hands out a bag per dose slot. Another bag while the period's bags are out is
        // a bag change — allowed, but confirmed, as an extra dispense of a regular order is (it used to go out silently, so
        // the run's bag went out twice). A bag for a missed slot never dispensed needs no confirmation: the drip still needs it.
        // On-demand drips (no frequency) have no slots and are dispensed when the bag runs out, as before.
        // A drip whose treatment duration is over, one with no bag today (a frequency over 24 h) or an on-demand drip that
        // starts after today is asked about first, as a Once / regular order outside its days is (they went out silently).
        if (sched.state === "ended" || sched.state === "no_dose_today")
            forceReason = `No bag of this drip today (${sched.stateText})`;
        else if (sched.state === "not_started")
            forceReason = `The order starts on ${row.start_date} at ${slotKey(anchor).slice(11, 16)} — dispense early?`;
        else if (sched.remaining.length > 0 && sched.toDispense.length === 0)
            forceReason = "This drip's bags for the rest of today were already dispensed — dispense another bag (bag change)?";
        else if (sched.slots.length > 0 && toRecord.length === 0)
            forceReason = "Today's bags of this drip were already dispensed — dispense another bag (bag change)?";
    }
    else {
        if (sched.remaining.length > 0 && sched.toDispense.length === 0)
            forceReason = "Today's remaining doses of this order were already dispensed";
        // every dose of the day already dispensed (e.g. a Once / operation dose given earlier and now past the grace window,
        // so it is no longer "remaining") — a second dispense is an extra one, as for regular orders
        else if (!isRegular && sched.slots.length > 0 && sched.slots.every((x) => x.state === "dispensed"))
            forceReason = "Today's doses of this order were already dispensed";
        // no dose of a Once / operation / care order today (its day is over, or an off day of a q48h order): an extra dispense
        else if (!isRegular && sched.slots.length === 0)
            forceReason = sched.stateText ? `No dose of this order today (${sched.stateText})` : "No dose of this order today";
        else if (isRegular && sched.remaining.length === 0)
            forceReason = sched.stateText ? `No doses remaining today (${sched.stateText})` : "No doses of this order remaining today";
    }
    // item / frequency / first dose time / qty per dose changed after today's doses were dispensed (dose slots no longer
    // match the schedule): every dispense of this order today needs a deliberate confirmation. For an early dispense that
    // is the start day (a Once dispensed early, then moved within its day: its new time looked like a dose never given)
    if (editedAfterDispense(d, editDay, row.id).size)
        forceReason = editDay === w.label ? "The order was edited after today's doses were dispensed — check what was dispensed before dispensing again"
            : "The order was edited after its first doses were dispensed early — check what was dispensed before dispensing again";
    return {
        orderId: row.id, itemId: row.item_id, itemName: row.item_name, unit: row.unit ?? null, qtyPerDose: qpd, isDrip, isRegular,
        type: (isDrip ? "drip" : "midday"), status: row.status, schedule: sched,
        defaultQty: round3(qpd * doses), needsForce: !!forceReason, forceReason, stock: stockOf(d, row.item_id, locationId), toRecord,
    };
}
const dispenseSchema = z.object({
    qty: zQty,
    allowPartial: z.boolean().optional(),
    force: z.boolean().optional(),
    /** The pack scanned to check it (core/scan.ts). */
    scan: z.string().max(300).nullish(),
});
export default async function routes(app) {
    /** Current stock of an item at this pharmacy: usable / expired / TEMP, plus what FEFO can dispense. */
    app.get("/stock/:itemId", async (req) => {
        const d = db();
        const i = item(d, req.params.itemId);
        return { itemId: i.id, itemName: i.selection_name || i.name, unit: i.unit, ...stockOf(d, i.id, req.ctx.locationId) };
    });
    /** Preview for the quantity dialog of "Dispense & print". */
    app.get("/orders/:orderId/plan", async (req) => {
        const d = db();
        const row = orderRow(d, parse(zId, req.params.orderId), req.ctx.locationId);
        return planFor(d, row, req.ctx.locationId);
    });
    /**
     * Mid-day print & dispense (regular / once / care / operation) or drip print & dispense (continuous drips).
     * 409 codes: not_active, needs_force (nothing left to dispense today), no_stock, short (pass allowPartial to dispense what is available).
     */
    app.post("/orders/:orderId", async (req) => {
        requirePerm(req, "dispense");
        const d = db();
        const id = parse(zId, req.params.orderId);
        const b = parse(dispenseSchema, req.body);
        const loc = req.ctx.locationId;
        const out = d.tx(() => {
            const row = orderRow(d, id, loc);
            if (!row.patient_active)
                throw new HttpError(409, "Patient is inactive");
            if (row.status !== "active")
                throw new HttpError(409, row.status === "hold" ? "Order on hold — cannot dispense" : "Order stopped — cannot dispense", { code: "not_active" });
            // a second pharmacist verifies new and changed orders first, when the hospital requires it (release 1.9); work
            // replayed from a pharmacy PC was checked there
            if (req.ctx.token !== "replay" && verificationMode() === "required"
                && !d.get("SELECT 1 FROM medication_orders WHERE id = ? AND verified_at IS NOT NULL", [id]))
                throw new HttpError(409, "A second pharmacist has not verified this order yet (Clinical → Verify orders)", { code: "not_verified" });
            const plan = planFor(d, row, loc);
            if (plan.needsForce && !b.force)
                throw new HttpError(409, plan.forceReason, { code: "needs_force" });
            // only the item that is dispensed counts (an order's diluent is not what leaves the shelf here)
            const scanned = checkScan(req, d, row.item_id, b.scan);
            const avail = plan.stock.available;
            if (avail <= 0)
                throw new HttpError(409, "No usable stock of this item in the pharmacy", { code: "no_stock", available: 0 });
            const qty = round3(b.qty);
            if (qty > avail && !b.allowPartial)
                throw new HttpError(409, `Only ${avail} on hand`, { code: "short", available: avail });
            const res = dispenseFEFO(d, {
                locationId: loc, itemId: row.item_id, qty: Math.min(qty, avail), type: plan.type, patientId: row.patient_id,
                patientName: row.patient_name, orderId: row.id, userId: req.ctx.userId, preferBatch: scanned?.batch,
            });
            if (scanned)
                d.run("UPDATE dispenses SET scan_code = ? WHERE run_id = ?", [scanned.code, res.runId]);
            // record the dose slots this quantity actually covers (whole doses only, earliest first)
            const covered = plan.toRecord.reduce((n) => (res.dispensed >= round3((n + 1) * plan.qtyPerDose) - 1e-9 ? n + 1 : n), 0); // k doses = round3(k × dose), as FEFO dispenses them
            const slots = plan.toRecord.slice(0, covered);
            const now = nowIso();
            for (const s of slots)
                d.run("INSERT OR IGNORE INTO dispensed_slots(order_id, slot_at, run_id, at) VALUES (?,?,?,?)", [row.id, s, res.runId, now]);
            // drips: legacy runs the next-dispense calculator before printing
            if (plan.isDrip) {
                const vol = parseVolume(row.dose), rate = row.drip_rate;
                if (vol && rate && rate > 0 && res.dispensed > 0)
                    d.run("UPDATE medication_orders SET next_dispense_at = ?, updated_at = ? WHERE id = ?", [toLocalIso(addHours(clockNow(), vol / rate)).slice(0, 16), now, row.id]);
            }
            return { res, plan, slots };
        });
        const { res, plan, slots } = out;
        const row = orderRow(d, id, loc);
        // labels: the doses dispensed now; else the remaining ones; else every copy of the day (legacy) — limited to the doses
        // the dispensed quantity covers; drips one label
        let times;
        if (plan.isDrip)
            times = [null];
        else {
            const s = scheduleSettings(d);
            const t = (slots.length ? slots : plan.schedule.remaining).map((k) => k.slice(11, 16));
            times = t.length ? t : labelTimes(row, medicalDay(clockNow(), s.dayStart));
            if (!times.length)
                times = [null];
            // one label per dose actually dispensed (a part dose still gets its label), never more than the quantity covers
            times = times.slice(0, Math.max(1, Math.ceil(res.dispensed / plan.qtyPerDose - 1e-9)));
        }
        const labels = res.lines.length
            ? times.flatMap((t, k) => {
                const l = batchAt(res.lines, k * plan.qtyPerDose);
                return medicationLabels(d, row, loc, [t], { batchNo: l.batchNo, expiry: l.expiry, placeholder: l.placeholder });
            })
            : [];
        audit(req, `dispense.${plan.type}`, "order", id, { requested: b.qty, dispensed: res.dispensed, runId: res.runId, slots });
        return {
            runId: res.runId, requested: round3(b.qty), dispensed: res.dispensed, short: round3(b.qty - res.dispensed), lines: res.lines,
            slotsRecorded: slots, labelKind: plan.isDrip ? "drip" : "medication", labels, nextDispenseAt: row.next_dispense_at,
            stock: stockOf(d, row.item_id, loc),
        };
    });
    /**
     * Manual dispense of any item to the selected patient or to nobody (legacy frmSimpleDispense). To a patient it is
     * checked as a walk-in is (core/safety.ts: allergies, interactions and duplicates with the patient's running orders,
     * high-alert medicines and their second pharmacist; 409 safety_alerts until confirmed with `safety`), and the pack is
     * scanned when the scan setting asks for it (core/scan.ts).
     */
    app.post("/manual", async (req) => {
        requirePerm(req, "dispense");
        const d = db();
        const b = parse(z.object({
            itemId: z.string().trim().min(1, "Choose the item"),
            qty: zQty,
            patientId: zOptStr,
            allowPartial: z.boolean().optional(),
            notes: zOptStr,
            /** The pack scanned to check it (core/scan.ts). */
            scan: z.string().max(300).nullish(),
            safety: zSafetyAck,
        }), req.body);
        const loc = req.ctx.locationId;
        const i = item(d, b.itemId);
        const p = b.patientId ? patientInLocation(d, b.patientId, loc, { activeOnly: true }) : null;
        // the patient's own orders for this item are what a manual dispense usually tops up: not a duplicate of themselves
        const own = p ? d.all("SELECT id FROM medication_orders WHERE patient_id = ? AND item_id = ?", [p.id, i.id]).map((o) => o.id) : [];
        const alerts = p ? safetyAlerts(d, { patientId: p.id, candidates: [{ itemId: i.id }], doses: false, duplicates: true, replacing: own }) : [];
        const gate = { context: "dispense.manual", patientId: p?.id ?? null, ref: `item:${i.id}` };
        const res = d.tx(() => {
            const ok = gateSafety(req, d, alerts, b.safety);
            // a dispense to a patient is scanned as Ward dispensing's is, when the setting asks for it
            const scanned = p ? checkScan(req, d, i.id, b.scan) : null;
            const avail = available(d, i.id, loc);
            if (avail <= 0)
                throw new HttpError(409, "No usable stock of this item in the pharmacy", { code: "no_stock", available: 0 });
            const qty = round3(b.qty);
            if (qty > avail && !b.allowPartial)
                throw new HttpError(409, `Only ${avail} on hand`, { code: "short", available: avail });
            const r = dispenseFEFO(d, {
                locationId: loc, itemId: i.id, qty: Math.min(qty, avail), type: "manual", patientId: p?.id ?? null, patientName: p?.name ?? null,
                userId: req.ctx.userId, notes: b.notes, preferBatch: scanned?.batch,
            });
            if (scanned)
                d.run("UPDATE dispenses SET scan_code = ? WHERE run_id = ?", [scanned.code, r.runId]);
            if (r.dispensed > 0 && (ok.alerts.length || ok.notSeen?.length))
                logSafety(req, d, { ...gate, ref: `dispense_run:${r.runId}` }, ok);
            return r;
        });
        audit(req, "dispense.manual", "item", i.id, { patientId: p?.id ?? null, requested: b.qty, dispensed: res.dispensed, runId: res.runId });
        const info = alerts.filter((a) => a.level === "info");
        return { ...res, stock: stockOf(d, i.id, loc), ...(info.length ? { safety: info } : {}) };
    });
    /** Opening (container) label data: item + next FEFO batch + optional patient (legacy rptOpeningLabel). */
    app.get("/opening-label", async (req) => {
        const d = db();
        const q = req.query;
        const i = item(d, String(q.itemId ?? ""));
        const p = q.patientId ? patientInLocation(d, q.patientId, req.ctx.locationId) : null;
        const nb = nextBatch(d, i.id, req.ctx.locationId);
        return {
            itemName: i.selection_name || i.name, itemId: i.id, unit: i.unit, useWindow: i.use_window, batchNo: nb?.batch_no ?? null,
            batchExpiry: nb?.expiry_date ?? null, isPlaceholderBatch: !!nb?.is_placeholder, patientName: p?.name ?? null, patientId: p?.id ?? null,
            openedAt: nowIso(),
            itemFullName: i.name, ac: i.active_ingredient ?? null, conc: i.strength ?? null, concUnit: i.strength_unit ?? null,
            special: i.special ?? null, department: p?.department ?? null,
        };
    });
    /**
     * Return dialog data (legacy frmReturnBatchPrompt): last batch dispensed to this patient (prefill), the item's existing
     * expiries at this pharmacy with a suggested batch number each, and the net quantity the patient received.
     */
    app.get("/returns/prefill", async (req) => {
        const d = db();
        const q = req.query;
        const loc = req.ctx.locationId;
        const i = item(d, String(q.itemId ?? ""));
        const p = q.patientId ? patientInLocation(d, q.patientId, loc) : null;
        const last = p ? lastDispensedBatch(d, p.id, i.id, loc) : undefined;
        const lastIsPlaceholder = last ? !!d.get("SELECT is_placeholder FROM batches WHERE id = ?", [last.batch_id])?.is_placeholder : false;
        const batches = d.all(`SELECT b.id, b.batch_no, b.expiry_date, b.qty, b.is_placeholder,
              (SELECT MAX(x.at) FROM dispenses x WHERE x.batch_id = b.id AND x.type <> 'return') AS last_disp
       FROM batches b WHERE b.item_id = ? AND b.location_id = ? AND b.is_placeholder = 0
       ORDER BY IFNULL(b.expiry_date,'9999-12-31'), b.id`, [i.id, loc]);
        const byExp = new Map();
        for (const b of batches) {
            const k = b.expiry_date ?? "";
            if (!byExp.has(k))
                byExp.set(k, []);
            byExp.get(k).push(b);
        }
        // legacy SuggestBatchNoForExpiry: most recently dispensed batch with that expiry, else the newest batch
        const expiries = [...byExp.entries()].map(([exp, list]) => {
            const dispensed = list.filter((b) => b.last_disp).sort((a, b) => (b.last_disp > a.last_disp ? 1 : -1));
            const suggested = dispensed[0] ?? [...list].sort((a, b) => b.id - a.id)[0];
            return { expiry: exp || null, suggestedBatchNo: suggested.batch_no, batches: list.map((b) => ({ batchNo: b.batch_no, qty: round3(b.qty) })) };
        });
        const net = p ? d.get(`SELECT COALESCE(SUM(CASE WHEN type = 'return' THEN -qty ELSE qty END), 0) n FROM dispenses WHERE patient_id = ? AND item_id = ? AND location_id = ?`, [p.id, i.id, loc]).n : null;
        return {
            itemId: i.id, itemName: i.selection_name || i.name, unit: i.unit, patientId: p?.id ?? null, patientName: p?.name ?? null,
            last: last && !lastIsPlaceholder ? { batchNo: last.batch_no, expiry: last.expiry_date } : null,
            lastWasPlaceholder: lastIsPlaceholder, expiries, dispensedToPatient: net == null ? null : round3(net),
        };
    });
    /**
     * Return to stock (find-or-create the batch by item+location+batch+expiry). Warns, does not block, above the dispensed
     * amount. Never into a TEMP batch, and no never-expiring copy of a batch on record with an expiry (core/fefo.ts returnBatch).
     */
    app.post("/returns", async (req) => {
        requirePerm(req, "dispense");
        const d = db();
        const b = parse(z.object({
            itemId: z.string().trim().min(1, "Choose the item"),
            qty: zQty,
            patientId: zOptStr,
            batchNo: z.string().trim().min(1, "Enter the batch no.").max(60),
            expiry: zDate.nullish().transform((v) => v || null),
            notes: zOptStr,
        }), req.body);
        const loc = req.ctx.locationId;
        const i = item(d, b.itemId);
        const p = b.patientId ? patientInLocation(d, b.patientId, loc) : null;
        let warning = null;
        if (p) {
            const net = d.get(`SELECT COALESCE(SUM(CASE WHEN type = 'return' THEN -qty ELSE qty END), 0) n FROM dispenses WHERE patient_id = ? AND item_id = ? AND location_id = ?`, [p.id, i.id, loc]).n;
            if (b.qty > net + 1e-9)
                warning = `Return quantity (${round3(b.qty)}) is more than the net dispensed to this patient (${round3(Math.max(net, 0))})`;
        }
        const r = returnToStock(d, {
            locationId: loc, itemId: i.id, qty: b.qty, batchNo: b.batchNo, expiry: b.expiry, patientId: p?.id ?? null, patientName: p?.name ?? null,
            userId: req.ctx.userId, notes: b.notes,
        });
        audit(req, "dispense.return", "item", i.id, { patientId: p?.id ?? null, qty: r.qty, batchNo: r.batchNo, expiry: r.expiry, warning });
        return { ...r, warning, stock: stockOf(d, i.id, loc) };
    });
    /** Recent dispense history of a patient at this pharmacy (detail panel). */
    app.get("/patient/:patientId/history", async (req) => {
        const d = db();
        const p = patientInLocation(d, req.params.patientId, req.ctx.locationId);
        const limit = Math.min(Math.max(Number(req.query.limit ?? 40) || 40, 1), 200);
        return d.all(`SELECT x.id, x.at, x.qty, x.type, t.name AS "typeName", x.item_id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName",
              i.unit, b.batch_no AS "batchNo", b.expiry_date AS "expiry", b.is_placeholder AS "placeholder", x.order_id AS "orderId",
              u.display_name AS "userName"
       FROM dispenses x JOIN items i ON i.id = x.item_id LEFT JOIN batches b ON b.id = x.batch_id
       LEFT JOIN dispense_types t ON t.code = x.type LEFT JOIN users u ON u.id = x.user_id
       WHERE x.patient_id = ? AND x.location_id = ? ORDER BY x.at DESC, x.id DESC LIMIT ?`, [p.id, req.ctx.locationId, limit]);
    });
}
