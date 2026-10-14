import { HttpError } from "../lib/http.js";
import { now as clockNow, toLocalDate } from "../lib/time.js";
import { parseGs1, productCode } from "./gs1.js";
import { settingStr } from "./settings.js";
import { heldSql } from "./fefo.js";
const name = (d, id) => d.get("SELECT COALESCE(selection_name, name) n FROM items WHERE id = ?", [id])?.n ?? id;
/**
 * Checks a scanned pack against the item that is dispensed. Returns what to record (product code, and the batch / serial
 * of a 2D code) and the batch to dispense from; null when nothing was scanned.
 */
export function checkScan(req, d, itemId, scan) {
    const g = scan ? parseGs1(scan) : null;
    const record = (code) => ({ code: [code, g?.batch, g?.serial].filter(Boolean).join("|"), batch: g?.batch ?? null });
    if (req.ctx.token === "replay")
        return scan ? record(productCode(scan)) : null;
    const mode = settingStr("barcode.scan_before_dispense");
    const high = !!d.get("SELECT 1 FROM items WHERE id = ? AND high_alert = 1", [itemId]);
    const required = mode === "all" || (mode === "high_alert" && high);
    if (!scan) {
        if (required)
            throw new HttpError(409, "Scan the pack before dispensing", { code: "scan_required" });
        return null;
    }
    const code = productCode(scan);
    const linked = d.get("SELECT item_id FROM item_barcodes WHERE code = ?", [code]);
    if (!linked)
        throw new HttpError(409, "This barcode is not linked to any item — link it when receiving the pack, or in the item's details", { code: "scan_unknown" });
    if (linked.item_id !== itemId)
        throw new HttpError(409, `Wrong medicine: the pack is “${name(d, linked.item_id)}”, the order is for “${name(d, itemId)}”`, { code: "scan_mismatch" });
    if (g?.expiry && g.expiry < toLocalDate(clockNow()))
        throw new HttpError(409, `This pack expired on ${g.expiry} — take another`, { code: "scan_expired" });
    if (g?.batch) {
        const hold = d.get(`SELECT kind FROM batch_holds WHERE active = 1 AND item_id = ? AND batch_no = ? COLLATE NOCASE
      AND (location_id IS NULL OR location_id = ?)`, [itemId, g.batch, req.ctx.locationId]);
        if (hold)
            throw new HttpError(409, `Batch ${g.batch} is ${hold.kind === "recall" ? "recalled" : "in quarantine"} — do not give it; put it aside`, { code: "scan_held" });
        const here = d.get(`SELECT SUM(qty) qty FROM batches b WHERE b.item_id = ? AND b.location_id = ? AND b.batch_no = ? COLLATE NOCASE
      AND b.is_placeholder = 0 AND b.qty > 0 AND NOT ${heldSql("b")}`, [itemId, req.ctx.locationId, g.batch]);
        if (!here?.qty)
            throw new HttpError(409, `Batch ${g.batch} is not in this pharmacy's stock — receive it first (Stock → Receive), or take a pack of a batch on record`, { code: "scan_batch_unknown" });
    }
    return record(code);
}
