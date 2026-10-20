import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, notFound, parse, requirePerm } from "../../lib/http.js";
import { nowIso, now as clockNow, toLocalDate } from "../../lib/time.js";
import { parseGs1, productCode } from "../../core/gs1.js";
const zCode = z.string().min(1, "Scan or type a code").max(300, "The code is too long");
const ITEM = `i.id, i.name, i.selection_name AS "selectionName", i.unit, i.strength, i.strength_unit AS "strengthUnit", i.active`;
export default async function routes(app) {
    /**
     * What a scanned code is: { code, gs1, item, patient, batch }. `item` by the product code; `batch` (this pharmacy's
     * batch of that lot, with its hold) when the code carries a batch number; `patient` when the code is a patient ID of
     * this pharmacy (a patient label's barcode).
     */
    app.get("/lookup", async (req) => {
        const { code: raw } = parse(z.object({ code: zCode }), req.query);
        const d = db();
        const gs1 = parseGs1(raw);
        const code = productCode(raw);
        const item = d.get(`SELECT ${ITEM} FROM item_barcodes c JOIN items i ON i.id = c.item_id WHERE c.code = ?`, [code]) ?? null;
        let batch = null;
        if (item && gs1?.batch) {
            batch = d.get(`SELECT b.id, b.batch_no AS "batchNo", b.expiry_date AS expiry, b.qty, b.is_placeholder AS placeholder,
           (SELECT h.kind FROM batch_holds h WHERE h.active = 1 AND h.item_id = b.item_id AND h.batch_no = b.batch_no COLLATE NOCASE
              AND (h.location_id IS NULL OR h.location_id = b.location_id) LIMIT 1) AS hold
         FROM batches b WHERE b.item_id = ? AND b.location_id = ? AND b.batch_no = ? COLLATE NOCASE ORDER BY b.qty DESC LIMIT 1`, [item.id, req.ctx.locationId, gs1.batch]) ?? null;
            // a recall of the lot holds it even where this pharmacy has none of it yet
            if (!batch) {
                const h = d.get("SELECT kind FROM batch_holds WHERE active = 1 AND item_id = ? AND batch_no = ? COLLATE NOCASE AND (location_id IS NULL OR location_id = ?)", [item.id, gs1.batch, req.ctx.locationId]);
                if (h)
                    batch = { batchNo: gs1.batch, hold: h.kind, qty: 0 };
            }
        }
        const pid = raw.trim();
        const patient = !gs1 && /^[\w-]{3,30}$/.test(pid) ? d.get(`SELECT p.id, p.name, p.active FROM patients p JOIN departments dep ON dep.id = p.department_id WHERE p.id = ? AND dep.location_id = ?`, [pid, req.ctx.locationId]) ?? null : null;
        const expired = gs1?.expiry ? gs1.expiry < toLocalDate(clockNow()) : false;
        return { code, gs1, item: item ? { ...item, active: !!item.active } : null, batch, patient: patient ? { ...patient, active: !!patient.active } : null, expired };
    });
    /** The codes of an item. */
    app.get("/item/:itemId", async (req) => {
        const id = String(req.params.itemId);
        if (!db().get("SELECT 1 FROM items WHERE id = ?", [id]))
            throw notFound("Item");
        return db().all(`SELECT c.code, c.created_at AS "createdAt", u.display_name AS "createdBy" FROM item_barcodes c LEFT JOIN users u ON u.id = c.created_by
                     WHERE c.item_id = ? ORDER BY c.created_at`, [id]);
    });
    /** Link a code to an item (receiving staff when a pack's code is new, or the catalogue's editors). */
    app.post("/", async (req) => {
        if (!can(req.ctx, "items") && !can(req.ctx, "stock.receive"))
            throw new HttpError(403, "Your role does not allow linking barcodes to items");
        const b = parse(z.object({ code: zCode, itemId: z.string().trim().min(1, "Choose the item") }), req.body);
        const d = db();
        const code = productCode(b.code);
        if (code.length < 4)
            throw new HttpError(400, "This code is too short to be a product barcode");
        const item = d.get("SELECT id, name FROM items WHERE id = ?", [b.itemId]);
        if (!item)
            throw notFound("Item");
        const cur = d.get("SELECT c.item_id, i.name FROM item_barcodes c JOIN items i ON i.id = c.item_id WHERE c.code = ?", [code]);
        if (cur && cur.item_id !== item.id)
            throw new HttpError(409, `This barcode is already linked to “${cur.name}” — remove it there first`, { itemId: cur.item_id });
        if (!cur)
            d.run("INSERT INTO item_barcodes(code, item_id, created_at, created_by) VALUES (?,?,?,?)", [code, item.id, nowIso(), req.ctx.userId]);
        audit(req, "barcode.link", "item", item.id, { code });
        return { code, itemId: item.id };
    });
    app.delete("/:code", async (req) => {
        requirePerm(req, "items");
        const code = productCode(String(req.params.code)); // Fastify has decoded the address already
        const cur = db().get("SELECT item_id FROM item_barcodes WHERE code = ?", [code]);
        if (!cur)
            throw notFound("Barcode");
        db().run("DELETE FROM item_barcodes WHERE code = ?", [code]);
        audit(req, "barcode.unlink", "item", cur.item_id, { code });
        return { ok: true };
    });
}
