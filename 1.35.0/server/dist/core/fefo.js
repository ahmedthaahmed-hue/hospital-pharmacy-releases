import { nowIso, toLocalDate, now as clockNow, newRunId } from "../lib/time.js";
import { round3 } from "./schedule.js";
import { bad } from "../lib/http.js";
/**
 * SQL: is the batch row `b` (alias) on hold — quarantined at its pharmacy, or its lot recalled in every pharmacy
 * (batch_holds, release 1.5)? Held stock is never dispensed and does not count as usable.
 */
export const heldSql = (b) => `EXISTS (SELECT 1 FROM batch_holds h WHERE h.active = 1 AND h.item_id = ${b}.item_id
  AND h.batch_no = ${b}.batch_no COLLATE NOCASE AND (h.location_id IS NULL OR h.location_id = ${b}.location_id))`;
/**
 * While any batch of the item is held at the pharmacy, its temporary (TEMP) stock is not used either: TEMP stands for
 * packs on the shelf without a batch on record, and those may well be the held ones (a recall must not be dispensed
 * as TEMP, out of sight of its trace).
 */
export const tempBlockedSql = (b) => `(${b}.is_placeholder = 1 AND EXISTS (SELECT 1 FROM batch_holds h WHERE h.active = 1 AND h.item_id = ${b}.item_id
  AND (h.location_id IS NULL OR h.location_id = ${b}.location_id)))`;
function batchFilter(includePlaceholders, allowExpired) {
    return `item_id = ? AND location_id = ? AND qty > 0
    ${includePlaceholders ? "" : "AND is_placeholder = 0"}
    ${allowExpired ? "" : "AND (expiry_date IS NULL OR expiry_date >= ?)"}
    AND NOT ${heldSql("batches")} AND NOT ${tempBlockedSql("batches")}`;
}
/** Quantity FEFO can actually dispense (non-expired; placeholders included by default). */
/**
 * A controlled medicine (records, release 1.7) is never given from temporary (TEMP) stock: every dose must come from a
 * real batch, so that it is in the controlled register.
 */
function isControlled(db, itemId) {
    return !!db.get("SELECT controlled AS c FROM items WHERE id = ?", [itemId])?.c;
}
export function available(db, itemId, locationId, opts = {}) {
    const inc = (opts.includePlaceholders ?? true) && !isControlled(db, itemId), exp = opts.allowExpired ?? false;
    const params = [itemId, locationId];
    if (!exp)
        params.push(toLocalDate(clockNow()));
    const r = db.get(`SELECT COALESCE(SUM(qty),0) q FROM batches WHERE ${batchFilter(inc, exp)}`, params);
    return round3(r?.q ?? 0);
}
/** Stock split for display: usable / expired / placeholder / held (quarantined or recalled, not expired). */
export function stockSummary(db, itemId, locationId) {
    const today = toLocalDate(clockNow());
    const held = heldSql("batches");
    return db.get(`SELECT
       COALESCE(SUM(CASE WHEN is_placeholder=0 AND (expiry_date IS NULL OR expiry_date >= :t) AND NOT ${held} THEN qty END),0) usable,
       COALESCE(SUM(CASE WHEN expiry_date < :t THEN qty END),0) expired,
       COALESCE(SUM(CASE WHEN is_placeholder=1 AND (expiry_date IS NULL OR expiry_date >= :t) AND NOT ${held} AND NOT ${tempBlockedSql("batches")} THEN qty END),0) placeholder,
       COALESCE(SUM(CASE WHEN (expiry_date IS NULL OR expiry_date >= :t) AND ${held} THEN qty END),0) held
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
/**
 * Which batches FEFO would take `qty` from now, without taking anything (the daily run's picking list). Same order and
 * the same rules as dispenseFEFO.
 */
export function planFEFO(db, itemId, locationId, qty) {
    const params = [itemId, locationId, toLocalDate(clockNow())];
    // a controlled medicine never comes from TEMP stock (as in dispenseFEFO / available)
    const batches = db.all(`SELECT batch_no, expiry_date, qty, is_placeholder FROM batches WHERE ${batchFilter(!isControlled(db, itemId), false)}
     ORDER BY is_placeholder ASC, IFNULL(expiry_date,'9999-12-31') ASC, id ASC`, params);
    const out = [];
    let left = round3(qty);
    for (const b of batches) {
        if (left <= 0)
            break;
        const take = round3(Math.min(b.qty, left));
        out.push({ batchNo: b.batch_no, expiry: b.expiry_date, qty: take, placeholder: !!b.is_placeholder });
        left = round3(left - take);
    }
    return out;
}
export function dispenseFEFO(db, input) {
    const runId = input.runId ?? newRunId();
    const want = round3(Number(input.qty) || 0);
    const res = { runId, requested: want, dispensed: 0, short: want, lines: [] };
    if (want <= 0 || !input.itemId)
        return res;
    const inc = (input.includePlaceholders ?? true) && !isControlled(db, input.itemId), exp = input.allowExpired ?? false;
    return db.tx(() => {
        const params = [input.itemId, input.locationId];
        if (!exp)
            params.push(toLocalDate(clockNow()));
        params.push(input.preferBatch ?? "");
        const batches = db.all(`SELECT id, batch_no, expiry_date, qty, is_placeholder FROM batches WHERE ${batchFilter(inc, exp)}
       ORDER BY (batch_no = ? COLLATE NOCASE AND is_placeholder = 0) DESC, is_placeholder ASC, IFNULL(expiry_date,'9999-12-31') ASC, id ASC`, params);
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
/** The batch number of temporary (TEMP) stock (stock/service.ts PLACEHOLDER). */
export const TEMP_BATCH_NO = "XXX666";
/**
 * The batch a return goes into. Never a temporary (TEMP) one, whatever the letter case of its number; the same number
 * in another letter case is the batch on record. With no expiry given, a batch number already on record with an expiry
 * is that batch (a new batch that never expires is not made beside it), and a new batch needs its expiry unless the
 * item has none in any batch.
 */
export function returnBatch(db, itemId, locationId, batchNo, expiry) {
    const no = batchNo.trim();
    if (!no)
        throw bad("Enter the batch no.");
    if (no.toUpperCase() === TEMP_BATCH_NO
        || db.get("SELECT 1 FROM batches WHERE item_id = ? AND batch_no = ? COLLATE NOCASE AND is_placeholder = 1 LIMIT 1", [itemId, no]))
        throw bad("Cannot return to a temporary batch (TEMP) — enter the real batch no.");
    // real batches of this number (any letter case), this pharmacy's first and the exact spelling first
    const known = db.all(`SELECT batch_no, expiry_date, location_id FROM batches WHERE item_id = ? AND batch_no = ? COLLATE NOCASE AND is_placeholder = 0
     ORDER BY location_id = ? DESC, batch_no = ? DESC, id`, [itemId, no, locationId, no]);
    const here = known.filter((b) => b.location_id === locationId);
    if (expiry)
        return { batchNo: (here.find((b) => b.expiry_date === expiry) ?? known.find((b) => b.expiry_date === expiry))?.batch_no ?? no, expiry };
    const undated = here.find((b) => b.expiry_date == null);
    if (undated)
        return { batchNo: undated.batch_no, expiry: null };
    const expiries = (rows) => [...new Set(rows.map((b) => b.expiry_date).filter((e) => e != null))];
    const dated = expiries(here).length ? expiries(here) : expiries(known);
    if (dated.length === 1) {
        const b = here.find((x) => x.expiry_date === dated[0]) ?? known.find((x) => x.expiry_date === dated[0]);
        return { batchNo: b.batch_no, expiry: dated[0] };
    }
    if (dated.length > 1)
        throw bad(`Batch ${no} is on record with more than one expiry date — choose the expiry date`);
    if (db.get("SELECT 1 FROM batches WHERE item_id = ? AND is_placeholder = 0 AND expiry_date IS NOT NULL LIMIT 1", [itemId]))
        throw bad("Enter the expiry date of the returned pack");
    return { batchNo: no, expiry: null };
}
export function returnToStock(db, r) {
    const qty = round3(Number(r.qty) || 0);
    if (qty <= 0)
        throw new Error("Return quantity must be greater than zero");
    return db.tx(() => {
        const into = returnBatch(db, r.itemId, r.locationId, r.batchNo, r.expiry || null);
        const batchId = findOrCreateBatch(db, r.itemId, r.locationId, into.batchNo, into.expiry);
        const now = nowIso();
        db.run("UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?", [qty, batchId]);
        const d = db.run(`INSERT INTO dispenses(at, location_id, patient_id, patient_name, item_id, batch_id, qty, type, user_id, run_id, notes)
       VALUES (?,?,?,?,?,?,?,'return',?,?,?)`, [now, r.locationId, r.patientId ?? null, r.patientName ?? null, r.itemId, batchId, qty, r.userId ?? null, newRunId(),
            r.notes ?? `Return: Batch ${into.batchNo} Exp ${into.expiry ?? "?"}`]);
        db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,?,?,?,?)", [now, batchId, "return", qty, d.lastId, r.userId ?? null]);
        return { batchId, dispenseId: d.lastId, qty, batchNo: into.batchNo, expiry: into.expiry };
    });
}
/** Most recent batch dispensed to this patient for this item at this location (return prefill). */
export function lastDispensedBatch(db, patientId, itemId, locationId) {
    return db.get(`SELECT b.id batch_id, b.batch_no, b.expiry_date FROM dispenses d JOIN batches b ON b.id = d.batch_id
     WHERE d.patient_id = ? AND d.item_id = ? AND d.location_id = ? AND d.type <> 'return'
     ORDER BY d.at DESC, d.id DESC LIMIT 1`, [patientId, itemId, locationId]);
}
