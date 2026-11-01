import { HttpError, bad, notFound } from "../../lib/http.js";
import { nowIso, now as clockNow, toLocalDate } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { findOrCreateBatch, heldSql } from "../../core/fefo.js";
import { move } from "../stock/service.js";
const ref = (id) => `transfer:${id}`;
/** A transfer; each batch's unitCost only with `costs` (prices and stock value are purchasing's, `stock.purchase`). */
export function getTransfer(d, id, opts = {}) {
    const t = d.get(`SELECT t.id, t.from_location_id AS "fromLocationId", lf.name AS "fromName", t.to_location_id AS "toLocationId", lt.name AS "toName",
       t.status, t.kind, t.note, t.closed_note AS "closedNote", t.requested_at AS "requestedAt", ru.display_name AS "requestedBy",
       t.issued_at AS "issuedAt", iu.display_name AS "issuedBy", t.received_at AS "receivedAt", cu.display_name AS "receivedBy"
     FROM transfers t JOIN locations lf ON lf.id = t.from_location_id JOIN locations lt ON lt.id = t.to_location_id
     LEFT JOIN users ru ON ru.id = t.requested_by LEFT JOIN users iu ON iu.id = t.issued_by LEFT JOIN users cu ON cu.id = t.received_by
     WHERE t.id = ?`, [id]);
    if (!t)
        throw notFound("Transfer");
    const lines = d.all(`SELECT l.id, l.item_id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, l.qty_requested AS "qtyRequested", l.qty_issued AS "qtyIssued",
       (SELECT COALESCE(SUM(b.qty),0) FROM batches b WHERE b.item_id = l.item_id AND b.location_id = ? AND b.qty > 0 AND b.is_placeholder = 0
          AND (b.expiry_date IS NULL OR b.expiry_date >= ?) AND NOT ${heldSql("b")}) AS "availableAtSource"
     FROM transfer_lines l JOIN items i ON i.id = l.item_id WHERE l.transfer_id = ? ORDER BY l.id`, [t.fromLocationId, toLocalDate(clockNow()), id]);
    const batches = d.all(`SELECT id, line_id AS "lineId", item_id AS "itemId", batch_no AS "batchNo", expiry_date AS expiry, qty${opts.costs ? `, unit_cost AS "unitCost"` : ""} FROM transfer_batches WHERE transfer_id = ? ORDER BY id`, [id]);
    return { ...t, lines: lines.map((l) => ({ ...l, availableAtSource: round3(l.availableAtSource), batches: batches.filter((b) => b.lineId === l.id) })) };
}
/** Transfers a pharmacy takes part in: `side` incoming (to it), outgoing (from it), or both. */
export function listTransfers(d, locationId, opts) {
    const where = [opts.side === "in" ? "t.to_location_id = ?" : opts.side === "out" ? "t.from_location_id = ?" : "(t.to_location_id = ? OR t.from_location_id = ?)"];
    const params = opts.side ? [locationId] : [locationId, locationId];
    if (opts.open)
        where.push("t.status IN ('requested','issued')");
    return d.all(`SELECT t.id, t.from_location_id AS "fromLocationId", lf.name AS "fromName", t.to_location_id AS "toLocationId", lt.name AS "toName", t.status, t.kind,
       t.note, t.requested_at AS "requestedAt", ru.display_name AS "requestedBy", t.issued_at AS "issuedAt", t.received_at AS "receivedAt",
       (SELECT COUNT(*) FROM transfer_lines l WHERE l.transfer_id = t.id) AS "lineCount"
     FROM transfers t JOIN locations lf ON lf.id = t.from_location_id JOIN locations lt ON lt.id = t.to_location_id LEFT JOIN users ru ON ru.id = t.requested_by
     WHERE ${where.join(" AND ")} ORDER BY CASE t.status WHEN 'issued' THEN 0 WHEN 'requested' THEN 1 ELSE 2 END, t.id DESC LIMIT ?`, [...params, opts.limit ?? 200]);
}
function checkLines(d, lines) {
    if (!lines.length)
        throw bad("Add at least one item");
    const seen = new Set();
    for (const l of lines) {
        if (seen.has(l.itemId))
            throw bad("An item is in the list twice — add the quantities together");
        seen.add(l.itemId);
        if (!d.get("SELECT 1 FROM items WHERE id = ? AND active = 1", [l.itemId]))
            throw bad(`Item ${l.itemId} not found or inactive`);
        if (!(l.qty > 0))
            throw bad("Quantities must be greater than zero");
    }
}
/** A request from `to` to `from` (nothing moves yet). */
export function createRequest(d, a) {
    if (a.from === a.to)
        throw bad("Choose another pharmacy");
    for (const id of [a.from, a.to])
        if (!d.get("SELECT 1 FROM locations WHERE id = ? AND active = 1", [id]))
            throw bad("Pharmacy not found or inactive");
    checkLines(d, a.lines);
    return d.tx(() => {
        const id = d.run("INSERT INTO transfers(from_location_id, to_location_id, status, kind, note, requested_by, requested_at) VALUES (?,?,?,?,?,?,?)", [a.from, a.to, "requested", a.kind ?? "request", a.note, a.userId, nowIso()]).lastId;
        for (const l of a.lines)
            d.run("INSERT INTO transfer_lines(transfer_id, item_id, qty_requested) VALUES (?,?,?)", [id, l.itemId, round3(l.qty)]);
        return id;
    });
}
/**
 * Issue a requested transfer from the giving pharmacy: each line's quantity (default: what was asked; at most what is
 * usable there) leaves its batches, earliest expiry first (no TEMP, expired or held stock). Lines left at 0 are not sent.
 * `prefer` (item → batch no.) sends that batch first: the near-expiry batch being passed on.
 */
export function issue(d, id, qtys, userId, prefer = null) {
    return d.tx(() => {
        const t = d.get("SELECT status, from_location_id FROM transfers WHERE id = ?", [id]);
        if (!t)
            throw notFound("Transfer");
        if (t.status !== "requested")
            throw new HttpError(409, "This transfer was already issued or closed");
        const lines = d.all("SELECT id, item_id, qty_requested FROM transfer_lines WHERE transfer_id = ?", [id]);
        const today = toLocalDate(clockNow());
        const at = nowIso();
        let any = false;
        for (const l of lines) {
            const typed = qtys?.get(l.id);
            if (typed != null && typed < 0)
                throw bad("Quantities cannot be negative");
            const batches = d.all(`SELECT b.id, b.batch_no, b.expiry_date, b.qty, b.unit_cost FROM batches b WHERE b.item_id = ? AND b.location_id = ? AND b.qty > 0 AND b.is_placeholder = 0
         AND (b.expiry_date IS NULL OR b.expiry_date >= ?) AND NOT ${heldSql("b")}
         ORDER BY (b.batch_no = ? COLLATE NOCASE) DESC, IFNULL(b.expiry_date,'9999-12-31'), b.id`, [l.item_id, t.from_location_id, today, prefer?.get(l.item_id) ?? ""]);
            const avail = round3(batches.reduce((s, b) => s + b.qty, 0));
            // a quantity typed must be there; without one, what was asked, or what is usable when that is less
            let want = typed != null ? round3(typed) : round3(Math.min(l.qty_requested, avail));
            if (want > avail + 1e-9)
                throw new HttpError(409, `Only ${avail} usable of item ${l.item_id} here — lower its quantity`, { code: "short", itemId: l.item_id, available: avail });
            let issued = 0;
            for (const b of batches) {
                if (want <= 0)
                    break;
                const take = round3(Math.min(b.qty, want));
                move(d, b.id, "transfer", -take, userId, `Sent: transfer ${id}`, at, ref(id));
                d.run("INSERT INTO transfer_batches(transfer_id, line_id, item_id, batch_no, expiry_date, unit_cost, qty, from_batch_id) VALUES (?,?,?,?,?,?,?,?)", [id, l.id, l.item_id, b.batch_no, b.expiry_date, b.unit_cost, take, b.id]);
                want = round3(want - take);
                issued = round3(issued + take);
            }
            d.run("UPDATE transfer_lines SET qty_issued = ? WHERE id = ?", [issued, l.id]);
            if (issued > 0)
                any = true;
        }
        if (!any)
            throw bad("Nothing to send: every quantity is 0 — reject the request instead");
        d.run("UPDATE transfers SET status = 'issued', issued_by = ?, issued_at = ? WHERE id = ?", [userId, at, id]);
    });
}
/** Receive an issued transfer: its batches enter the receiving pharmacy (same number, expiry and cost). */
export function receive(d, id, userId) {
    return d.tx(() => {
        const t = d.get("SELECT status, to_location_id FROM transfers WHERE id = ?", [id]);
        if (!t)
            throw notFound("Transfer");
        if (t.status !== "issued")
            throw new HttpError(409, t.status === "received" ? "This transfer was already received" : "This transfer has not been issued yet");
        const at = nowIso();
        for (const b of d.all("SELECT id, item_id, batch_no, expiry_date, qty, unit_cost FROM transfer_batches WHERE transfer_id = ?", [id])) {
            const to = findOrCreateBatch(d, b.item_id, t.to_location_id, b.batch_no, b.expiry_date);
            if (b.unit_cost != null) {
                // the receiving batch's cost, averaged with what it already holds
                const cur = d.get("SELECT qty, unit_cost FROM batches WHERE id = ?", [to]);
                const cost = cur.unit_cost == null || cur.qty <= 0 ? b.unit_cost : (cur.unit_cost * cur.qty + b.unit_cost * b.qty) / (cur.qty + b.qty);
                d.run("UPDATE batches SET unit_cost = ? WHERE id = ?", [Math.round(cost * 10000) / 10000, to]);
            }
            move(d, to, "transfer", b.qty, userId, `Received: transfer ${id}`, at, ref(id));
            d.run("UPDATE transfer_batches SET to_batch_id = ? WHERE id = ?", [to, b.id]);
        }
        d.run("UPDATE transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?", [userId, at, id]);
    });
}
/**
 * Close a transfer without receiving it: the requester cancels, or the giver rejects, a request not issued yet; the
 * receiver refuses an issued one — its stock goes back into the batches it came from.
 */
export function close(d, id, how, note, userId) {
    return d.tx(() => {
        const t = d.get("SELECT status FROM transfers WHERE id = ?", [id]);
        if (!t)
            throw notFound("Transfer");
        if (how === "refused") {
            if (t.status !== "issued")
                throw new HttpError(409, "Only stock on its way can be refused");
            const at = nowIso();
            for (const b of d.all("SELECT from_batch_id, qty FROM transfer_batches WHERE transfer_id = ?", [id]))
                move(d, b.from_batch_id, "transfer", b.qty, userId, `Returned: transfer ${id} refused`, at, ref(id));
        }
        else if (t.status !== "requested")
            throw new HttpError(409, "Only a request not issued yet can be cancelled or rejected");
        d.run("UPDATE transfers SET status = ?, closed_note = ? WHERE id = ?", [how, note, id]);
    });
}
