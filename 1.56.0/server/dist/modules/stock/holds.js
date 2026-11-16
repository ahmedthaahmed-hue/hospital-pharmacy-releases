import { HttpError, bad, notFound } from "../../lib/http.js";
import { nowIso } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
const HOLD_SELECT = `SELECT h.id, h.item_id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, h.batch_no AS "batchNo",
  h.location_id AS "locationId", l.name AS "locationName", h.kind, h.reason, h.reference, h.active, h.created_at AS "createdAt",
  cu.display_name AS "createdBy", h.released_at AS "releasedAt", ru.display_name AS "releasedBy", h.release_note AS "releaseNote"
  FROM batch_holds h JOIN items i ON i.id = h.item_id LEFT JOIN locations l ON l.id = h.location_id
  LEFT JOIN users cu ON cu.id = h.created_by LEFT JOIN users ru ON ru.id = h.released_by`;
/**
 * The stock a hold covers, per pharmacy (batches of that lot not used up). `onlyAt`: just that pharmacy's (for those
 * who may not see other pharmacies' stock).
 */
function holdStock(d, h, onlyAt) {
    if (onlyAt != null && h.locationId == null)
        h = { ...h, locationId: onlyAt };
    return d.all(`SELECT b.location_id AS "locationId", l.name AS "locationName", ROUND(SUM(b.qty), 3) AS qty, MIN(b.expiry_date) AS expiry
     FROM batches b JOIN locations l ON l.id = b.location_id
     WHERE b.item_id = ? AND b.batch_no = ? COLLATE NOCASE AND b.is_placeholder = 0 ${h.locationId == null ? "" : "AND b.location_id = ?"}
     GROUP BY b.location_id HAVING SUM(b.qty) > 0 ORDER BY l.name`, h.locationId == null ? [h.itemId, h.batchNo] : [h.itemId, h.batchNo, h.locationId]);
}
/** Holds, active first; `locationId` limits them to those touching that pharmacy (its own and every recall). */
export function listHolds(d, opts) {
    const where = [];
    const params = [];
    if (opts.active)
        where.push("h.active = 1");
    if (opts.locationId != null) {
        where.push("(h.location_id IS NULL OR h.location_id = ?)");
        params.push(opts.locationId);
    }
    const rows = d.all(`${HOLD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.active DESC, h.created_at DESC LIMIT 500`, params);
    return rows.map((h) => {
        const stock = holdStock(d, h, opts.stockAt ?? null);
        return { ...h, active: !!h.active, stock, onHand: round3(stock.reduce((s, x) => s + x.qty, 0)) };
    });
}
export function getHold(d, id, stockAt = null) {
    const h = d.get(`${HOLD_SELECT} WHERE h.id = ?`, [id]);
    if (!h)
        throw notFound("Hold");
    const stock = holdStock(d, h, stockAt);
    return { ...h, active: !!h.active, stock, onHand: round3(stock.reduce((s, x) => s + x.qty, 0)) };
}
export function createHold(d, b, userId) {
    return d.tx(() => {
        const item = d.get("SELECT id FROM items WHERE id = ?", [b.itemId]);
        if (!item)
            throw bad("Item not found");
        const batchNo = b.batchNo.trim();
        if (!batchNo)
            throw bad("Enter the batch no.");
        const dup = d.get(`SELECT id FROM batch_holds WHERE active = 1 AND item_id = ? AND batch_no = ? COLLATE NOCASE AND (location_id IS NULL OR location_id IS ?)`, [b.itemId, batchNo, b.locationId]);
        if (dup)
            throw new HttpError(409, "This batch is already on hold", { holdId: dup.id });
        const id = d.run(`INSERT INTO batch_holds(item_id, batch_no, location_id, kind, reason, reference, active, created_at, created_by) VALUES (?,?,?,?,?,?,1,?,?)`, [b.itemId, batchNo, b.locationId, b.kind, b.reason, b.reference, nowIso(), userId]).lastId;
        return id;
    });
}
export function releaseHold(d, id, note, userId) {
    const h = d.get("SELECT active FROM batch_holds WHERE id = ?", [id]);
    if (!h)
        throw notFound("Hold");
    if (!h.active)
        throw new HttpError(409, "This hold was already released");
    d.run("UPDATE batch_holds SET active = 0, released_at = ?, released_by = ?, release_note = ? WHERE id = ?", [nowIso(), userId, note, id]);
}
/**
 * Who received the lot: every dispense and return from a batch of it (in every pharmacy for a recall), newest first,
 * with the patient — the list a recall needs.
 */
export function traceLot(d, h) {
    const rows = d.all(`SELECT x.id, x.at, x.type, x.qty, x.patient_id AS "patientId", COALESCE(p.name, x.patient_name) AS "patientName",
            dep.name AS "department", l.name AS "locationName", x.order_id AS "orderId", x.walkin_ticket_id AS "ticketId", u.display_name AS "user"
     FROM dispenses x JOIN batches b ON b.id = x.batch_id JOIN locations l ON l.id = x.location_id
     LEFT JOIN patients p ON p.id = x.patient_id LEFT JOIN departments dep ON dep.id = p.department_id LEFT JOIN users u ON u.id = x.user_id
     WHERE b.item_id = ? AND b.batch_no = ? COLLATE NOCASE ${h.locationId == null ? "" : "AND b.location_id = ?"}
     ORDER BY x.at DESC, x.id DESC LIMIT 5000`, h.locationId == null ? [h.itemId, h.batchNo] : [h.itemId, h.batchNo, h.locationId]);
    const patients = new Map();
    for (const r of rows) {
        if (!r.patientId)
            continue;
        const p = patients.get(r.patientId) ?? { patientId: r.patientId, patientName: r.patientName, qty: 0, last: r.at };
        p.qty = round3(p.qty + (r.type === "return" ? -r.qty : r.qty));
        if (r.at > p.last)
            p.last = r.at;
        patients.set(r.patientId, p);
    }
    return { dispenses: rows, patients: [...patients.values()].filter((p) => p.qty > 0) };
}
/** Is this lot recalled (in every pharmacy)? For receiving: a recalled lot is refused. */
export function recalledLot(d, itemId, batchNo) {
    return d.get("SELECT id, reason, reference FROM batch_holds WHERE active = 1 AND kind = 'recall' AND location_id IS NULL AND item_id = ? AND batch_no = ? COLLATE NOCASE", [itemId, batchNo.trim()]);
}
