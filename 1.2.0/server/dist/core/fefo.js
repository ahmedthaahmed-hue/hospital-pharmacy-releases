import { nowIso, toLocalDate, now as clockNow, newRunId } from "../lib/time.js";
import { round3 } from "./schedule.js";
function batchFilter(includePlaceholders, allowExpired) {
    return `item_id = ? AND location_id = ? AND qty > 0
    ${includePlaceholders ? "" : "AND is_placeholder = 0"}
    ${allowExpired ? "" : "AND (expiry_date IS NULL OR expiry_date >= ?)"}`;
}
/** Quantity FEFO can actually dispense (non-expired; placeholders included by default). */
export function available(db, itemId, locationId, opts = {}) {
    const inc = opts.includePlaceholders ?? true, exp = opts.allowExpired ?? false;
    const params = [itemId, locationId];
    if (!exp)
        params.push(toLocalDate(clockNow()));
    const r = db.get(`SELECT COALESCE(SUM(qty),0) q FROM batches WHERE ${batchFilter(inc, exp)}`, params);
    return round3(r?.q ?? 0);
}
/** Stock split for display: usable / expired / placeholder. */
export function stockSummary(db, itemId, locationId) {
    const today = toLocalDate(clockNow());
    return db.get(`SELECT
       COALESCE(SUM(CASE WHEN is_placeholder=0 AND (expiry_date IS NULL OR expiry_date >= :t) THEN qty END),0) usable,
       COALESCE(SUM(CASE WHEN expiry_date < :t THEN qty END),0) expired,
       COALESCE(SUM(CASE WHEN is_placeholder=1 AND (expiry_date IS NULL OR expiry_date >= :t) THEN qty END),0) placeholder
     FROM batches WHERE item_id = :i AND location_id = :l AND qty > 0`, { t: today, i: itemId, l: locationId });
}
/** Batch that supplied the dose starting at `offset` units into the dispense (labels show the actual batch). */
export function batchAt(lines, offset) {
    let cum = 0;
    for (const l of lines) {
        cum += l.qty;
        if (offset < cum - 1e-9)
            return l;
    }
    return lines[lines.length - 1];
}
export function dispenseFEFO(db, input) {
    const runId = input.runId ?? newRunId();
    const want = round3(Number(input.qty) || 0);
    const res = { runId, requested: want, dispensed: 0, short: want, lines: [] };
    if (want <= 0 || !input.itemId)
        return res;
    const inc = input.includePlaceholders ?? true, exp = input.allowExpired ?? false;
    return db.tx(() => {
        const params = [input.itemId, input.locationId];
        if (!exp)
            params.push(toLocalDate(clockNow()));
        const batches = db.all(`SELECT id, batch_no, expiry_date, qty, is_placeholder FROM batches WHERE ${batchFilter(inc, exp)}
       ORDER BY is_placeholder ASC, IFNULL(expiry_date,'9999-12-31') ASC, id ASC`, params);
        let remaining = want;
        const now = nowIso();
        for (const b of batches) {
            if (remaining <= 0)
                break;
            const take = round3(Math.min(b.qty, remaining));
            if (take <= 0)
                continue;
            db.run("UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?", [take, b.id]);
            const d = db.run(`INSERT INTO dispenses(at, location_id, patient_id, patient_name, order_id, walkin_ticket_id, item_id, batch_id, qty, type, user_id, run_id, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [now, input.locationId, input.patientId ?? null, input.patientName ?? null, input.orderId ?? null, input.ticketId ?? null,
                input.itemId, b.id, take, input.type, input.userId ?? null, runId, input.notes ?? null]);
            db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,?,?,?,?)", [now, b.id, "dispense", -take, d.lastId, input.userId ?? null]);
            res.lines.push({ batchId: b.id, batchNo: b.batch_no, expiry: b.expiry_date, qty: take, placeholder: !!b.is_placeholder, dispenseId: d.lastId });
            remaining = round3(remaining - take);
        }
        res.dispensed = round3(want - remaining);
        res.short = remaining;
        return res;
    });
}
/** Find a batch by its full key or create it with qty 0 (legacy FindOrCreateBatch). */
export function findOrCreateBatch(db, itemId, locationId, batchNo, expiry) {
    const b = db.get("SELECT id FROM batches WHERE item_id=? AND location_id=? AND batch_no=? AND IFNULL(expiry_date,'')=IFNULL(?,'')", [itemId, locationId, batchNo, expiry]);
    if (b)
        return b.id;
    return db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,0,0,?)", [itemId, locationId, batchNo, expiry, nowIso()]).lastId;
}
export function returnToStock(db, r) {
    const qty = round3(Number(r.qty) || 0);
    if (qty <= 0)
        throw new Error("Return quantity must be greater than zero");
    return db.tx(() => {
        const batchId = findOrCreateBatch(db, r.itemId, r.locationId, r.batchNo.trim(), r.expiry || null);
        const now = nowIso();
        db.run("UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?", [qty, batchId]);
        const d = db.run(`INSERT INTO dispenses(at, location_id, patient_id, patient_name, item_id, batch_id, qty, type, user_id, run_id, notes)
       VALUES (?,?,?,?,?,?,?,'return',?,?,?)`, [now, r.locationId, r.patientId ?? null, r.patientName ?? null, r.itemId, batchId, qty, r.userId ?? null, newRunId(),
            r.notes ?? `Return: Batch ${r.batchNo} Exp ${r.expiry ?? "?"}`]);
        db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,?,?,?,?)", [now, batchId, "return", qty, d.lastId, r.userId ?? null]);
        return { batchId, dispenseId: d.lastId, qty };
    });
}
/** Most recent batch dispensed to this patient for this item at this location (return prefill). */
export function lastDispensedBatch(db, patientId, itemId, locationId) {
    return db.get(`SELECT b.id batch_id, b.batch_no, b.expiry_date FROM dispenses d JOIN batches b ON b.id = d.batch_id
     WHERE d.patient_id = ? AND d.item_id = ? AND d.location_id = ? AND d.type <> 'return'
     ORDER BY d.at DESC, d.id DESC LIMIT 1`, [patientId, itemId, locationId]);
}
