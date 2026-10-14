import { findOrCreateBatch } from "../../core/fefo.js";
import { round3 } from "../../core/schedule.js";
import { HttpError, bad } from "../../lib/http.js";
import { addDays, now, nowIso, parseLocal, toLocalDate } from "../../lib/time.js";
export const PLACEHOLDER = { batchNo: "XXX666", expiry: "2099-12-31", qty: 1_000_000 };
/** Today at the request clock (a receipt replayed from a pharmacy PC is checked against the day it was entered). */
export function today() { return toLocalDate(now()); }
function setting(d, key, fallback) {
    const v = Number(d.get("SELECT value FROM settings WHERE key=?", [key])?.value);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}
/** Usable (non-TEMP, non-expired) quantity below which a stocked item is flagged low. Setting 'stock.low_threshold'. */
export const lowThreshold = (d) => setting(d, "stock.low_threshold", 10);
/** Expiry warning window in days. Setting 'stock.expiry_warn_days'. */
export const expiryWarnDays = (d) => setting(d, "stock.expiry_warn_days", 90);
export function daysBetween(fromIso, toIso) {
    return Math.round((parseLocal(toIso).getTime() - parseLocal(fromIso).getTime()) / 86_400_000);
}
/** Change a batch quantity and write its ledger row. Must run inside a transaction. */
export function move(d, batchId, kind, delta, userId, note, at = nowIso()) {
    delta = round3(delta);
    if (delta === 0)
        return;
    const b = d.get("SELECT qty FROM batches WHERE id=?", [batchId]);
    if (!b)
        throw new HttpError(404, "Batch not found");
    if (round3(b.qty + delta) < 0)
        throw bad("Batch on hand cannot go below zero");
    d.run("UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?", [delta, batchId]);
    d.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,user_id,note) VALUES (?,?,?,?,?,?)", [at, batchId, kind, delta, userId, note]);
}
export function isValidDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return false;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}
/* ---------------- TEMP usage ---------------- */
/**
 * Quantity dispensed from TEMP placeholder batches since the item's last real receipt at the pharmacy (net of returns),
 * i.e. stock that left the shelf without a real batch on record. Uses dispense history, so legacy TEMP dispenses count too.
 */
export function tempUsage(d, locationId, itemId) {
    const rows = d.all(`SELECT d.item_id AS itemId, SUM(CASE WHEN d.type='return' THEN -d.qty ELSE d.qty END) AS used, MAX(d.at) AS lastAt
     FROM dispenses d JOIN batches b ON b.id = d.batch_id
     WHERE d.location_id = :l AND b.is_placeholder = 1 ${itemId ? "AND d.item_id = :i" : ""}
       AND d.at > IFNULL((SELECT MAX(m.at) FROM stock_movements m JOIN batches rb ON rb.id = m.batch_id
                          WHERE rb.item_id = d.item_id AND rb.location_id = :l AND rb.is_placeholder = 0 AND m.kind = 'receive'), '')
     GROUP BY d.item_id HAVING used > 0.0005`, itemId ? { l: locationId, i: itemId } : { l: locationId });
    return new Map(rows.map((r) => [r.itemId, { used: round3(r.used), lastAt: r.lastAt }]));
}
export function overview(d, locationId) {
    const t = today();
    const low = lowThreshold(d), warn = expiryWarnDays(d);
    const rows = d.all(`SELECT i.id AS itemId, i.item_no AS itemNo, i.name, i.selection_name AS selectionName, i.unit, i.form, i.class, i.active,
       COALESCE(SUM(CASE WHEN b.is_placeholder=0 AND b.qty>0 AND (b.expiry_date IS NULL OR b.expiry_date >= :t) THEN b.qty END),0) usable,
       COALESCE(SUM(CASE WHEN b.is_placeholder=0 AND b.qty>0 AND b.expiry_date < :t THEN b.qty END),0) expired,
       COALESCE(SUM(CASE WHEN b.is_placeholder=1 AND b.qty>0 AND (b.expiry_date IS NULL OR b.expiry_date >= :t) THEN b.qty END),0) placeholder,
       MIN(CASE WHEN b.is_placeholder=0 AND b.qty>0 AND b.expiry_date >= :t THEN b.expiry_date END) nearestExpiry,
       COUNT(CASE WHEN b.is_placeholder=0 AND b.qty>0 THEN 1 END) batchCount,
       COUNT(CASE WHEN b.is_placeholder=0 THEN 1 END) realBatches
     FROM items i LEFT JOIN batches b ON b.item_id = i.id AND b.location_id = :l
     GROUP BY i.id
     HAVING i.active = 1 OR COUNT(CASE WHEN b.qty>0 THEN 1 END) > 0
     ORDER BY i.name`, { t, l: locationId });
    const temp = tempUsage(d, locationId);
    return rows.map((r) => {
        const usable = round3(r.usable), expired = round3(r.expired);
        const stocked = r.realBatches > 0;
        const daysToExpiry = r.nearestExpiry ? daysBetween(t, r.nearestExpiry) : null;
        return {
            itemId: r.itemId, itemNo: r.itemNo, name: r.name, selectionName: r.selectionName, unit: r.unit, form: r.form, class: r.class, active: r.active,
            usable, expired, placeholder: round3(r.placeholder), tempUsed: temp.get(r.itemId)?.used ?? 0, total: round3(usable + expired),
            nearestExpiry: r.nearestExpiry, daysToExpiry, batchCount: r.batchCount, stocked,
            low: stocked && usable > 0 && usable < low, out: stocked && usable <= 0,
            expiring: daysToExpiry !== null && daysToExpiry <= warn,
        };
    });
}
/* ---------------- Batches & ledger ---------------- */
const BATCH_COLS = `b.id, b.item_id AS "itemId", b.location_id AS "locationId", b.batch_no AS "batchNo", b.expiry_date AS "expiry",
  b.qty, b.is_placeholder AS "placeholder", b.created_at AS "createdAt"`;
function decorate(b, t = today()) {
    const days = b.expiry ? daysBetween(t, b.expiry) : null;
    return { ...b, placeholder: !!b.placeholder, daysToExpiry: days, expired: days !== null && days < 0 };
}
export function itemBatches(d, itemId, locationId, includeEmpty) {
    return d.all(`SELECT ${BATCH_COLS},
       (SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements m WHERE m.batch_id=b.id) AS "ledgerQty",
       (SELECT MAX(at) FROM stock_movements m WHERE m.batch_id=b.id) AS "lastMovementAt"
     FROM batches b WHERE b.item_id=? AND b.location_id=? ${includeEmpty ? "" : "AND b.qty > 0"}
     ORDER BY b.is_placeholder, IFNULL(b.expiry_date,'9999-12-31'), b.id`, [itemId, locationId]).map((b) => decorate(b));
}
export function getBatch(d, id) {
    const b = d.get(`SELECT ${BATCH_COLS}, i.name AS "itemName", i.selection_name AS "selectionName", i.unit, l.name AS "locationName"
     FROM batches b JOIN items i ON i.id=b.item_id JOIN locations l ON l.id=b.location_id WHERE b.id=?`, [id]);
    return b ? decorate(b) : undefined;
}
const LEDGER_SELECT = `
  SELECT m.id, m.at, m.kind, m.qty_delta AS "qtyDelta", m.note, m.batch_id AS "batchId", b.batch_no AS "batchNo", b.expiry_date AS "expiry",
         b.is_placeholder AS "placeholder", u.display_name AS "userName",
         d.id AS "dispenseId", d.type AS "dispenseType", dt.name AS "dispenseTypeName", d.patient_id AS "patientId",
         COALESCE(p.name, d.patient_name) AS "patientName", d.order_id AS "orderId", d.walkin_ticket_id AS "ticketId"
  FROM stock_movements m
  JOIN batches b ON b.id = m.batch_id
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN dispenses d ON d.id = m.dispense_id
  LEFT JOIN dispense_types dt ON dt.code = d.type
  LEFT JOIN patients p ON p.id = d.patient_id`;
/** Ledger of one batch, oldest first, with running balance. */
export function batchLedger(d, batchId) {
    const b = d.get("SELECT qty FROM batches WHERE id=?", [batchId]);
    if (!b)
        return null;
    const rows = d.all(`${LEDGER_SELECT} WHERE m.batch_id=? ORDER BY m.at, m.id`, [batchId]);
    const sum = round3(rows.reduce((s, r) => s + r.qtyDelta, 0));
    // Databases imported before the 'import' opening movement existed: show the inferred opening balance.
    let bal = round3(b.qty - sum);
    const out = bal !== 0 ? [{ id: 0, at: null, kind: "opening", qtyDelta: bal, balance: bal, note: "Opening balance not in the log" }] : [];
    for (const r of rows) {
        bal = round3(bal + r.qtyDelta);
        out.push({ ...r, placeholder: !!r.placeholder, balance: bal });
    }
    return { rows: out, reconciled: Math.abs(b.qty - sum) < 0.0005, qty: b.qty, ledgerQty: sum };
}
/** Recent ledger rows across all batches of an item at a pharmacy, newest first. */
export function itemLedger(d, itemId, locationId, limit) {
    return d.all(`${LEDGER_SELECT} WHERE b.item_id=? AND b.location_id=? ORDER BY m.at DESC, m.id DESC LIMIT ?`, [itemId, locationId, limit])
        .map((r) => ({ ...r, placeholder: !!r.placeholder }));
}
export function receive(d, locationId, lines, userId, reference) {
    const t = today();
    return d.tx(() => {
        const at = nowIso();
        return lines.map((l, idx) => {
            const n = idx + 1;
            const item = d.get("SELECT id, name, active FROM items WHERE id=?", [l.itemId]);
            if (!item)
                throw bad(`Line ${n}: item not found`);
            if (!item.active)
                throw bad(`Line ${n}: item “${item.name}” is inactive — activate it first`);
            const batchNo = l.batchNo.trim();
            if (!batchNo)
                throw bad(`Line ${n}: enter the batch no.`);
            if (batchNo.toUpperCase() === PLACEHOLDER.batchNo)
                throw bad(`Line ${n}: batch no. ${PLACEHOLDER.batchNo} is reserved for temporary stock`);
            if (!isValidDate(l.expiry))
                throw bad(`Line ${n}: invalid expiry date`);
            if (l.expiry < t)
                throw bad(`Line ${n}: expiry date has passed — expired stock cannot be received`);
            const qty = round3(l.qty);
            if (!(qty > 0))
                throw bad(`Line ${n}: quantity must be greater than zero`);
            const existing = d.get("SELECT id, is_placeholder FROM batches WHERE item_id=? AND location_id=? AND batch_no=? AND IFNULL(expiry_date,'')=?", [item.id, locationId, batchNo, l.expiry]);
            if (existing?.is_placeholder)
                throw bad(`Line ${n}: this is a temporary batch (TEMP)`);
            const other = d.get("SELECT expiry_date FROM batches WHERE item_id=? AND location_id=? AND batch_no=? AND IFNULL(expiry_date,'')<>? AND is_placeholder=0 LIMIT 1", [item.id, locationId, batchNo, l.expiry]);
            const batchId = existing?.id ?? findOrCreateBatch(d, item.id, locationId, batchNo, l.expiry);
            move(d, batchId, "receive", qty, userId, reference, at);
            const newQty = d.get("SELECT qty FROM batches WHERE id=?", [batchId]).qty;
            return {
                itemId: item.id, itemName: item.name, batchId, batchNo, expiry: l.expiry, qty, newQty, created: !existing,
                warning: other ? `The same batch no. exists with another expiry date (${other.expiry_date ?? "none"})` : null,
            };
        });
    });
}
/* ---------------- Adjust & count ---------------- */
export function adjust(d, batchId, newQty, expectedQty, reason, userId) {
    return d.tx(() => {
        const b = d.get("SELECT qty, is_placeholder FROM batches WHERE id=?", [batchId]);
        if (!b)
            throw new HttpError(404, "Batch not found");
        if (b.is_placeholder)
            throw bad("Temporary batches are not adjusted by hand — use the temporary stock tab");
        // Single edit: refuse if the batch moved since the user loaded it (a dispense happened meanwhile).
        if (expectedQty != null && Math.abs(b.qty - expectedQty) > 0.0005)
            throw new HttpError(409, `The batch on hand changed to ${round3(b.qty)} since the screen was opened — check the number and try again`, { qty: b.qty });
        const delta = round3(newQty - b.qty);
        if (delta === 0)
            throw bad("The new quantity equals the current on hand");
        move(d, batchId, "adjust", delta, userId, reason);
        return { batchId, before: b.qty, after: round3(b.qty + delta), delta };
    });
}
/**
 * Apply a count sheet. Each line's difference is (counted − quantity the sheet showed); that difference is applied to the
 * current quantity, so dispenses that happened while the count was in progress are not lost or double counted.
 */
export function applyCount(d, locationId, lines, reason, userId) {
    return d.tx(() => {
        const at = nowIso();
        const out = [];
        const seen = new Set();
        for (const l of lines) {
            if (seen.has(l.batchId))
                throw bad("Batch is repeated in the stock count");
            seen.add(l.batchId);
            const b = d.get("SELECT qty, location_id, is_placeholder, batch_no FROM batches WHERE id=?", [l.batchId]);
            if (!b || b.location_id !== locationId)
                throw bad("Batch not found in this pharmacy");
            if (b.is_placeholder)
                throw bad("Temporary batches (TEMP) are not counted");
            if (!(l.countedQty >= 0))
                throw bad(`Invalid counted quantity for batch ${b.batch_no}`);
            const delta = round3(l.countedQty - l.expectedQty);
            if (delta === 0)
                continue;
            if (round3(b.qty + delta) < 0)
                throw bad(`Batch ${b.batch_no}: the difference makes on hand go below zero (on hand now ${round3(b.qty)})`);
            move(d, l.batchId, "adjust", delta, userId, `Stock count: ${reason}`, at);
            out.push({ batchId: l.batchId, before: b.qty, after: round3(b.qty + delta), delta });
        }
        return { adjusted: out.length, netDelta: round3(out.reduce((s, x) => s + x.delta, 0)), lines: out };
    });
}
/** Batches for the count sheet: real batches at the pharmacy (with stock, or all). */
export function countSheet(d, locationId, includeEmpty) {
    const t = today();
    return d.all(`SELECT ${BATCH_COLS}, i.name AS "itemName", i.selection_name AS "selectionName", i.unit, i.class
     FROM batches b JOIN items i ON i.id=b.item_id
     WHERE b.location_id=? AND b.is_placeholder=0 ${includeEmpty ? "" : "AND b.qty > 0"}
     ORDER BY i.name, IFNULL(b.expiry_date,'9999-12-31'), b.id`, [locationId]).map((b) => decorate(b, t));
}
/* ---------------- Expiry ---------------- */
export function expiring(d, locationId, days) {
    const t = today();
    const until = toLocalDate(addDays(parseLocal(t), days));
    return d.all(`SELECT ${BATCH_COLS}, i.name AS "itemName", i.selection_name AS "selectionName", i.unit
     FROM batches b JOIN items i ON i.id=b.item_id
     WHERE b.location_id=? AND b.is_placeholder=0 AND b.qty>0 AND b.expiry_date >= ? AND b.expiry_date <= ?
     ORDER BY b.expiry_date, i.name`, [locationId, t, until]).map((b) => decorate(b, t));
}
export function expired(d, locationId) {
    const t = today();
    return d.all(`SELECT ${BATCH_COLS}, i.name AS "itemName", i.selection_name AS "selectionName", i.unit
     FROM batches b JOIN items i ON i.id=b.item_id
     WHERE b.location_id=? AND b.qty>0 AND b.is_placeholder=0 AND b.expiry_date < ?
     ORDER BY b.expiry_date, i.name`, [locationId, t]).map((b) => decorate(b, t));
}
/* ---------------- Placeholders (TEMP) ---------------- */
const USABLE_TEMP = "b.is_placeholder=1 AND b.qty>0 AND (b.expiry_date IS NULL OR b.expiry_date >= :t)";
export function placeholderStatus(d, locationId) {
    const t = today();
    const r = d.get(`SELECT
       (SELECT COUNT(DISTINCT b.item_id) FROM batches b WHERE b.location_id=:l AND ${USABLE_TEMP}) withTemp,
       (SELECT COUNT(*) FROM items i WHERE i.active=1 AND NOT EXISTS
          (SELECT 1 FROM batches b WHERE b.item_id=i.id AND b.location_id=:l AND ${USABLE_TEMP})) withoutTemp,
       (SELECT COUNT(*) FROM batches b WHERE b.location_id=:l AND b.is_placeholder=1 AND b.qty>0 AND b.expiry_date < :t) expiredTemp,
       (SELECT COUNT(*) FROM items WHERE active=1) activeItems`, { l: locationId, t });
    const usage = tempUsage(d, locationId);
    const ids = [...usage.keys()];
    const info = new Map(ids.length ? d.all(`SELECT i.id, i.name, i.selection_name AS "selectionName", i.unit,
       (SELECT COALESCE(SUM(x.qty),0) FROM batches x WHERE x.item_id=i.id AND x.location_id=? AND x.is_placeholder=0 AND x.qty>0
          AND (x.expiry_date IS NULL OR x.expiry_date >= ?)) AS usable
     FROM items i WHERE i.id IN (${ids.map(() => "?").join(",")})`, [locationId, t, ...ids]).map((x) => [x.id, x]) : []);
    const used = ids.map((id) => {
        const it = info.get(id);
        const u = usage.get(id);
        return { itemId: id, name: it.name, selectionName: it.selectionName, unit: it.unit, usable: round3(it.usable), tempUsed: u.used, lastTempDispenseAt: u.lastAt };
    }).sort((a, b) => b.tempUsed - a.tempUsed);
    return { withTemp: r.withTemp, withoutTemp: r.withoutTemp, expiredTemp: r.expiredTemp, activeItems: r.activeItems, used };
}
export function createPlaceholders(d, locationId, userId) {
    return d.tx(() => {
        const at = nowIso();
        // "Lacking" = no TEMP batch that FEFO could still dispense (an expired legacy TEMP batch does not count).
        const items = d.all(`SELECT i.id FROM items i WHERE i.active=1 AND NOT EXISTS
         (SELECT 1 FROM batches b WHERE b.item_id=i.id AND b.location_id=:l AND ${USABLE_TEMP})`, { l: locationId, t: today() });
        let created = 0, toppedUp = 0;
        for (const it of items) {
            const ex = d.get("SELECT id, qty, is_placeholder FROM batches WHERE item_id=? AND location_id=? AND batch_no=? AND IFNULL(expiry_date,'')=?", [it.id, locationId, PLACEHOLDER.batchNo, PLACEHOLDER.expiry]);
            if (ex && !ex.is_placeholder)
                continue; // a real batch numbered XXX666 (legacy data) — leave it alone
            let id = ex?.id;
            if (!id) {
                id = d.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,0,1,?)", [it.id, locationId, PLACEHOLDER.batchNo, PLACEHOLDER.expiry, at]).lastId;
                created++;
            }
            else
                toppedUp++;
            move(d, id, "placeholder", PLACEHOLDER.qty - (ex?.qty ?? 0), userId, "Temporary stock (TEMP) created", at);
        }
        return { created, toppedUp, items: created + toppedUp };
    });
}
export function removePlaceholders(d, locationId, userId) {
    return d.tx(() => {
        const at = nowIso();
        const rows = d.all("SELECT id, qty FROM batches WHERE location_id=? AND is_placeholder=1 AND qty>0", [locationId]);
        for (const b of rows)
            move(d, b.id, "placeholder", -b.qty, userId, "Temporary stock (TEMP) removed", at);
        return { removed: rows.length };
    });
}
/** Batches whose quantity does not equal the sum of their ledger rows (should always be empty). */
export function reconcile(d, locationId) {
    return d.all(`SELECT b.id, b.item_id AS "itemId", b.batch_no AS "batchNo", b.qty, COALESCE(SUM(m.qty_delta),0) AS "ledgerQty"
     FROM batches b LEFT JOIN stock_movements m ON m.batch_id=b.id
     WHERE b.location_id=? GROUP BY b.id HAVING ABS(b.qty - COALESCE(SUM(m.qty_delta),0)) > 0.0005`, [locationId]);
}
