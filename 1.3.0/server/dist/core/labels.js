import { dispenseDaysCompact } from "./schedule.js";
import { toLocalDate, now as clockNow } from "../lib/time.js";
import { batchAt } from "./fefo.js";
/** Orders with patient + item + department joined, for labels and runs. */
export const ORDER_SELECT = `
  SELECT o.*, p.name AS patient_name, p.is_child, p.notes AS patient_notes, p.active AS patient_active,
         d.name AS department, d.location_id AS patient_location_id,
         COALESCE(i.selection_name, i.name) AS item_name, i.unit AS unit,
         i.name AS item_full_name, i.active_ingredient AS item_ac, i.strength AS item_conc, i.strength_unit AS item_conc_unit,
         i.special AS item_special, i.use_window AS item_use_window,
         COALESCE(si.selection_name, si.name) AS sec_item_name, si.name AS sec_item_full_name
  FROM medication_orders o
  JOIN patients p ON p.id = o.patient_id
  LEFT JOIN departments d ON d.id = p.department_id
  JOIN items i ON i.id = o.item_id
  LEFT JOIN items si ON si.id = o.sec_item_id`;
/** Next FEFO batch shown on labels: earliest non-expired batch with stock at the location (real stock before TEMP). */
export function nextBatch(db, itemId, locationId) {
    return db.get(`SELECT batch_no, expiry_date, is_placeholder FROM batches
     WHERE item_id=? AND location_id=? AND qty>0 AND (expiry_date IS NULL OR expiry_date >= ?)
     ORDER BY is_placeholder, IFNULL(expiry_date,'9999-12-31'), id LIMIT 1`, [itemId, locationId, toLocalDate(clockNow())]);
}
/**
 * Batch each already-dispensed dose (slot 'YYYY-MM-DDTHH:MM') of an order came from, so labels printed again after the
 * dispense show the batch and expiry the patient received rather than today's next FEFO batch. A dispense records its
 * slots in the order its quantity covered them (dispensed_slots rowid), so the k-th slot of a dispense came from the
 * batch at offset k × qty per dose of that dispense's rows.
 */
export function dispensedSlotBatches(db, orderId, qtyPerDose, slots) {
    const out = new Map();
    if (!slots.length)
        return out;
    const runs = db.all(`SELECT DISTINCT run_id FROM dispensed_slots WHERE order_id = ? AND slot_at IN (${slots.map(() => "?").join(",")})`, [orderId, ...slots]);
    for (const { run_id } of runs) {
        const lines = db.all(`SELECT x.qty, b.batch_no, b.expiry_date, b.is_placeholder FROM dispenses x LEFT JOIN batches b ON b.id = x.batch_id
       WHERE x.run_id = ? AND x.order_id = ? AND x.type <> 'return' ORDER BY x.id`, [run_id, orderId]);
        if (!lines.length)
            continue;
        const covered = db.all("SELECT slot_at FROM dispensed_slots WHERE order_id = ? AND run_id = ? ORDER BY rowid", [orderId, run_id]);
        covered.forEach((s, k) => {
            const l = batchAt(lines, k * qtyPerDose);
            if (l.batch_no != null)
                out.set(s.slot_at, { batchNo: l.batch_no, expiry: l.expiry_date, placeholder: !!l.is_placeholder });
        });
    }
    return out;
}
/** One label per dose time ('HH:MM'); pass [null] for a single label without a time. */
export function medicationLabels(db, o, locationId, doseTimes, batch) {
    const b = batch === undefined ? nextBatch(db, o.item_id, locationId) : null;
    const batchNo = batch ? batch.batchNo : b?.batch_no ?? null;
    const batchExpiry = batch ? batch.expiry : b?.expiry_date ?? null;
    const placeholder = batch ? batch.placeholder : !!b?.is_placeholder;
    const days = dispenseDaysCompact(o);
    return doseTimes.map((t) => ({
        orderId: o.id, patientId: o.patient_id, patientName: o.patient_name, department: o.department ?? null, isChild: !!o.is_child,
        patientNotes: o.patient_notes ?? null, itemName: o.item_name, dose: o.dose, route: o.route, unit: o.unit ?? null,
        qtyPerDose: o.qty_per_dose, doseTime: t, frequencyHours: o.order_type === "once" ? null : o.frequency_hours, notes: o.notes, orderType: o.order_type,
        batchNo, batchExpiry, isPlaceholderBatch: placeholder, dispenseDays: days || null, secItemName: o.sec_item_name ?? null,
        dripRate: o.drip_rate ?? null, nextDispenseAt: o.next_dispense_at ?? null,
        itemFullName: o.item_full_name ?? o.item_name, ac: o.item_ac ?? null, conc: o.item_conc ?? null, concUnit: o.item_conc_unit ?? null,
        special: o.item_special ?? null, useWindow: o.item_use_window ?? null, durationDays: o.duration_days ?? null,
        secItemFullName: o.sec_item_full_name ?? null,
    }));
}
