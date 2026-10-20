// 24 h / selected-times run (legacy frmPrintFilter.btnPrintDirect_Click), rebuilt on the single schedule engine.
// Legacy bugs fixed here (FEATURES.md §5):
//  #11 order status honoured (stopped / hold are skipped with a reason, never dispensed)
//  #14 one schedule engine (core/schedule.ts) with the 06:00 medical day for both modes
//  #8  idempotent: each dose slot is dispensed once (dispensed_slots), re-running never dispenses twice
//  #9  decimal quantities (0.5 tablet dispenses 0.5, not 0)
//  #10 availability = what FEFO can dispense (expired excluded), aggregated per item across all orders
//  #15 only patients whose department belongs to this pharmacy (legacy LEFT JOIN + Nz() pulled orphans everywhere)
//  #33 summary is returned as data and stored (dispense_runs), not written to %TEMP% and opened in Notepad
//  #7  dispense + slot marking are one transaction per order
import { verificationMode } from "../clinical/schema.js";
import { ORDER_SELECT, dispensedSlotBatches, medicationLabels } from "../../core/labels.js";
import { planForWindow, medicalDay, medicalDayOf, SKIP_TEXT, DAY_START, dosesCovered, round3 } from "../../core/schedule.js";
import { available, batchAt, stockSummary, dispenseFEFO } from "../../core/fefo.js";
import { HttpError, bad } from "../../lib/http.js";
import { slotKey, toHHMM, toLocalIso, nowIso, now as clockNow, newRunId } from "../../lib/time.js";
import { editedAfterDispense } from "../orders/view.js";
/**
 * Whole dose slots `qty` covers. FEFO dispenses round3(n × perDose), so that counts as n doses even when the dose has
 * more decimals (0.3333 × 1 → 0.333 counted 0 doses, and every re-run dispensed the dose again).
 */
export const wholeDoses = dosesCovered;
const perDoseOf = (o) => (o.qty_per_dose && o.qty_per_dose > 0 ? o.qty_per_dose : 1);
export function dayStartSetting(db) {
    return db.get("SELECT value FROM settings WHERE key='schedule.day_start'")?.value || DAY_START;
}
export function windowFor(db, date) {
    const ds = dayStartSetting(db);
    return date ? medicalDayOf(date, ds) : medicalDay(clockNow(), ds);
}
function scopeFilter(p) {
    const parts = [];
    const params = [];
    if (p.scope?.patientId) {
        parts.push("p.id = ?");
        params.push(p.scope.patientId);
    }
    else if (p.scope?.departmentId) {
        parts.push("d.id = ?");
        params.push(p.scope.departmentId);
    }
    return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}
/** Active patients of the pharmacy (department → location), narrowed by the run scope. */
export function scopePatients(db, locationId, p) {
    const f = scopeFilter(p);
    const rows = db.all(`SELECT p.id, p.name, p.coverage, p.diagnosis, p.dob, p.is_child, p.notes, d.id AS department_id, d.name AS department
     FROM patients p JOIN departments d ON d.id = p.department_id
     WHERE p.active = 1 AND d.location_id = ?${f.sql}
     ORDER BY p.name, p.id`, [locationId, ...f.params]);
    if (p.scope?.patientId && !rows.length)
        throw bad("Patient not found in this pharmacy, or inactive");
    return rows;
}
function scopeOrders(db, locationId, p) {
    const f = scopeFilter(p);
    const types = (p.orderTypes ?? []).filter(Boolean);
    const typeSql = types.length ? ` AND o.order_type IN (${types.map(() => "?").join(",")})` : "";
    return db.all(`${ORDER_SELECT}
     WHERE p.active = 1 AND d.location_id = ?${f.sql}${typeSql}
     ORDER BY p.name, p.id, CASE WHEN o.order_type = 'regular' THEN 0 ELSE 1 END, o.display_order, o.id`, [locationId, ...f.params, ...types]);
}
/** Dose slots already dispensed in the window, per order. */
function doneSlots(db, w, orderId) {
    const rows = db.all(`SELECT order_id, slot_at FROM dispensed_slots WHERE slot_at > ? AND slot_at <= ?${orderId ? " AND order_id = ?" : ""}`, orderId ? [slotKey(w.start), slotKey(w.end), orderId] : [slotKey(w.start), slotKey(w.end)]);
    const m = new Map();
    for (const r of rows) {
        if (!m.has(r.order_id))
            m.set(r.order_id, new Set());
        m.get(r.order_id).add(r.slot_at);
    }
    return m;
}
function validate(p) {
    if (p.mode === "selected_times" && !(p.doseTimes ?? []).length)
        throw bad("Choose at least one dose time");
}
/** Build the plan: what a run would dispense / skip / find short, without changing anything. */
export function buildPlan(db, locationId, p, o = {}) {
    validate(p);
    const w = windowFor(db, p.date);
    const times = p.mode === "selected_times" ? (p.doseTimes ?? []) : undefined;
    const patients = scopePatients(db, locationId, p);
    const byPatient = new Map();
    for (const r of patients)
        byPatient.set(r.id, {
            patientId: r.id, patientName: r.name, department: r.department ?? null, departmentId: r.department_id ?? null, coverage: r.coverage ?? null,
            diagnosis: r.diagnosis ?? null, dob: r.dob ?? null, isChild: !!r.is_child, notes: r.notes ?? null, orders: [],
        });
    const rows = new Map();
    const skipCounts = {};
    if (p.reportType === "medication") {
        const done = doneSlots(db, w);
        const edited = editedAfterDispense(db, w.label);
        // orders a second pharmacist has not verified yet are left out when the hospital requires it (release 1.9); work
        // replayed from a pharmacy PC was checked there
        const mustVerify = !o.replay && verificationMode() === "required";
        const unverified = mustVerify ? new Set(db.all("SELECT id FROM medication_orders WHERE verified_at IS NULL").map((r) => r.id)) : new Set();
        for (const o of scopeOrders(db, locationId, p)) {
            const pp = byPatient.get(o.patient_id);
            if (!pp)
                continue;
            rows.set(o.id, o);
            let dp = planForWindow(o, w, times);
            // item / frequency / first dose time / qty per dose changed after this day's doses were dispensed: the dispensed
            // slots no longer match the schedule, so the run leaves the order to the pharmacist for this day
            if (!dp.skip && edited.has(o.id))
                dp = { ...dp, skip: "changed_after_dispense", nextDose: null };
            if (!dp.skip && unverified.has(o.id))
                dp = { ...dp, skip: "unverified", nextDose: null };
            const doneSet = done.get(o.id) ?? new Set();
            const slots = dp.slots.map((s) => ({ at: slotKey(s), time: toHHMM(s), done: doneSet.has(slotKey(s)) }));
            const pending = slots.filter((s) => !s.done).length;
            const perDose = perDoseOf(o);
            const plan = {
                orderId: o.id, patientId: o.patient_id, itemId: o.item_id, itemName: o.item_name, unit: o.unit ?? null, dose: o.dose ?? null,
                route: o.route ?? null, orderType: o.order_type, frequencyHours: o.frequency_hours ?? null, qtyPerDose: perDose, notes: o.notes ?? null,
                status: o.status, startDate: o.start_date, firstDoseTime: o.first_dose_time, durationDays: o.duration_days ?? null,
                slots, pending, qty: round3(pending * perDose), expectedQty: 0, state: "ready",
            };
            if (dp.skip) {
                plan.state = "skip";
                plan.skip = dp.skip;
                plan.skipText = SKIP_TEXT[dp.skip];
                plan.qty = 0;
                plan.pending = 0;
                plan.nextDose = dp.nextDose ? toLocalIso(dp.nextDose).slice(0, 16) : null;
                skipCounts[dp.skip] = (skipCounts[dp.skip] ?? 0) + 1;
            }
            else if (pending === 0) {
                plan.state = "already";
            }
            pp.orders.push(plan);
        }
    }
    // Aggregate demand per item and allocate stock in run order (same order execute dispenses in).
    const items = new Map();
    const left = new Map();
    for (const pp of byPatient.values())
        for (const o of pp.orders) {
            if (o.state !== "ready")
                continue;
            let it = items.get(o.itemId);
            if (!it) {
                const avail = available(db, o.itemId, locationId);
                const s = stockSummary(db, o.itemId, locationId);
                it = { itemId: o.itemId, itemName: o.itemName, unit: o.unit, orders: 0, demand: 0, available: avail,
                    usable: round3(s.usable), placeholder: round3(s.placeholder), expired: round3(s.expired), short: 0 };
                items.set(o.itemId, it);
                left.set(o.itemId, avail);
            }
            it.orders++;
            it.demand = round3(it.demand + o.qty);
            const rem = left.get(o.itemId);
            const cover = Math.min(o.pending, wholeDoses(rem, o.qtyPerDose));
            o.expectedQty = round3(cover * o.qtyPerDose);
            left.set(o.itemId, round3(rem - o.expectedQty));
            o.state = cover === 0 ? "out" : cover < o.pending ? "partial" : "ready";
        }
    for (const it of items.values())
        it.short = round3(Math.max(0, it.demand - it.available));
    const all = [...byPatient.values()];
    const patientsOut = p.reportType === "medication" ? all.filter((pp) => pp.orders.length > 0) : all;
    const orders = patientsOut.flatMap((pp) => pp.orders);
    const count = (s) => orders.filter((o) => o.state === s).length;
    const today = medicalDay(clockNow(), dayStartSetting(db)).label;
    const plan = {
        window: { start: toLocalIso(w.start).slice(0, 16), end: toLocalIso(w.end).slice(0, 16), label: w.label, isCurrent: w.label === today },
        mode: p.mode, doseTimes: times ?? [], reportType: p.reportType, orderTypes: p.orderTypes ?? [],
        patients: patientsOut,
        items: [...items.values()].sort((a, b) => (b.short > 0 ? 1 : 0) - (a.short > 0 ? 1 : 0) || a.itemName.localeCompare(b.itemName)),
        totals: {
            patients: patientsOut.length, orders: orders.length, ready: count("ready"), partial: count("partial"), out: count("out"),
            already: count("already"), skipped: count("skip"),
            labels: p.reportType === "patient" ? patientsOut.length : orders.filter((o) => o.state === "ready" || o.state === "partial").reduce((n, o) => n + o.pending, 0),
            shortItems: [...items.values()].filter((i) => i.short > 0).length,
        },
        skipCounts,
    };
    return { plan, window: w, rows };
}
export const PAST_DAY_TEXT = "This medical day has ended — dispense for the previous day?";
export function executeRun(db, locationId, p, opts) {
    if (!opts.dispense && !opts.print)
        throw bad("Choose dispense or print");
    const dispense = p.reportType === "medication" && opts.dispense;
    const { plan, window: w, rows } = buildPlan(db, locationId, p, { replay: opts.replay });
    // dispensing a medical day that has already ended needs an explicit confirmation (print-only stays allowed)
    if (dispense && !opts.force && w.label < medicalDay(clockNow(), dayStartSetting(db)).label)
        throw new HttpError(409, PAST_DAY_TEXT, { code: "needs_force" });
    const runId = newRunId();
    const at = nowIso();
    const selected = opts.orderIds ? new Set(opts.orderIds) : null;
    const lines = [];
    const medLabels = [];
    let deselected = 0;
    const type = p.mode === "day" ? "run_24h" : "selected_times";
    const skipCounts = {};
    if (p.reportType === "medication") {
        for (const pp of plan.patients)
            for (const o of pp.orders) {
                if (selected && !selected.has(o.orderId)) {
                    deselected++;
                    continue;
                }
                const row = rows.get(o.orderId);
                const base = {
                    orderId: o.orderId, patientId: pp.patientId, patientName: pp.patientName, department: pp.department,
                    itemId: o.itemId, itemName: o.itemName, unit: o.unit, requested: 0, qty: 0, slots: [], uncovered: [],
                    batches: [],
                };
                if (o.state === "skip") {
                    skipCounts[o.skip] = (skipCounts[o.skip] ?? 0) + 1;
                    lines.push({ ...base, outcome: "skipped", reason: o.skip, reasonText: o.skipText, nextDose: o.nextDose ?? null });
                    continue;
                }
                if (!dispense) {
                    // Print only: labels for every dose of the window (re-print), nothing dispensed.
                    // A dose already dispensed shows the batch it was dispensed from; the others the next FEFO batch.
                    const times = o.slots.map((s) => s.time);
                    lines.push({ ...base, outcome: "printed", requested: o.qty, slots: times });
                    const given = dispensedSlotBatches(db, o.orderId, o.qtyPerDose, o.slots.filter((s) => s.done).map((s) => s.at));
                    for (const s of o.slots)
                        medLabels.push(...medicationLabels(db, row, locationId, [s.time], given.get(s.at)));
                    continue;
                }
                try {
                    const res = db.tx(() => {
                        // Re-read inside the transaction: another run / mid-day dispense may have taken slots since the preview.
                        const done = doneSlots(db, w, o.orderId).get(o.orderId) ?? new Set();
                        const pending = o.slots.filter((s) => !done.has(s.at));
                        const requested = round3(pending.length * o.qtyPerDose);
                        if (!pending.length)
                            return { outcome: "already_dispensed", requested, covered: [], uncovered: [], r: null };
                        // Dispense whole doses only, so every unit dispensed belongs to a recorded slot (a partial dose would be
                        // dispensed again on the next run). Same availability rule as FEFO (expired excluded).
                        const cover = Math.min(pending.length, wholeDoses(available(db, o.itemId, locationId), o.qtyPerDose));
                        if (cover === 0)
                            return { outcome: "out_of_stock", requested, covered: [], uncovered: pending, r: null };
                        const r = dispenseFEFO(db, {
                            locationId, itemId: o.itemId, qty: round3(cover * o.qtyPerDose), type, patientId: pp.patientId, patientName: pp.patientName,
                            orderId: o.orderId, userId: opts.userId, runId,
                        });
                        const n = Math.min(cover, wholeDoses(r.dispensed, o.qtyPerDose));
                        const covered = pending.slice(0, n);
                        for (const s of covered)
                            db.run("INSERT INTO dispensed_slots(order_id, slot_at, run_id, at) VALUES (?,?,?,?)", [o.orderId, s.at, runId, at]);
                        return { outcome: n < pending.length ? "partial" : "dispensed", requested, covered, uncovered: pending.slice(n), r };
                    });
                    const line = {
                        ...base, outcome: res.outcome, requested: res.requested, qty: res.r?.dispensed ?? 0,
                        slots: res.covered.map((s) => s.time), uncovered: res.uncovered.map((s) => s.time),
                        batches: (res.r?.lines ?? []).map((l) => ({ batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, placeholder: l.placeholder })),
                    };
                    if (res.outcome === "already_dispensed") {
                        line.reasonText = SKIP_TEXT.already_dispensed;
                        line.slots = o.slots.map((s) => s.time);
                    }
                    if (res.outcome === "out_of_stock")
                        line.reasonText = SKIP_TEXT.out_of_stock;
                    lines.push(line);
                    if (opts.print && res.covered.length) {
                        // each dose's label shows the batch that dose's quantity came from (FEFO may span batches)
                        res.covered.forEach((s, k) => {
                            const l = batchAt(res.r.lines, k * o.qtyPerDose);
                            medLabels.push(...medicationLabels(db, row, locationId, [s.time], { batchNo: l.batchNo, expiry: l.expiry, placeholder: l.placeholder }));
                        });
                    }
                }
                catch (e) {
                    if (e instanceof HttpError)
                        throw e;
                    lines.push({ ...base, outcome: "error", error: String(e?.message ?? e) });
                }
            }
    }
    let labels;
    if (p.reportType === "patient") {
        const loc = db.get("SELECT name FROM locations WHERE id=?", [locationId])?.name ?? null;
        labels = {
            kind: "patient",
            items: opts.print ? plan.patients.map((pp) => ({
                patientId: pp.patientId, patientName: pp.patientName, department: pp.department, coverage: pp.coverage, diagnosis: pp.diagnosis,
                dob: pp.dob, isChild: pp.isChild, notes: pp.notes, location: loc,
            })) : [],
        };
    }
    else {
        labels = { kind: "medication", items: opts.print ? medLabels : [] };
    }
    const c = (k) => lines.filter((l) => l.outcome === k).length;
    const scopeNames = {
        patientId: p.scope?.patientId ?? null,
        patientName: p.scope?.patientId ? plan.patients[0]?.patientName ?? null : null,
        departmentId: p.scope?.departmentId ?? null,
        departmentName: p.scope?.departmentId ? db.get("SELECT name FROM departments WHERE id=?", [p.scope.departmentId])?.name ?? null : null,
    };
    const summary = {
        runId, at, userId: opts.userId, mode: p.reportType === "patient" ? "patient_labels" : p.mode, window: plan.window, doseTimes: plan.doseTimes,
        dispense, print: opts.print, reportType: p.reportType, scope: scopeNames, orderTypes: p.orderTypes ?? [],
        counts: {
            dispensed: c("dispensed"), partial: c("partial"), outOfStock: c("out_of_stock"), already: c("already_dispensed"),
            skipped: c("skipped"), printed: c("printed"), errors: c("error"), labels: labels.items.length, deselected,
        },
        skipCounts,
        lines,
    };
    db.run("INSERT INTO dispense_runs(id, at, user_id, location_id, mode, params, summary, labels) VALUES (?,?,?,?,?,?,?,?)", [
        runId, at, opts.userId, locationId, summary.mode,
        JSON.stringify({ ...p, dispense, print: opts.print, orderIds: opts.orderIds ?? null }), JSON.stringify(summary), JSON.stringify(labels),
    ]);
    return { summary, labels };
}
