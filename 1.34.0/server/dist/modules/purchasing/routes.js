import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, can, HttpError, notFound, parse, requirePerm, zId } from "../../lib/http.js";
import { nowIso, now as clockNow, toLocalDate } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { heldSql } from "../../core/fefo.js";
import { move } from "../stock/service.js";
const zText = (max = 200) => z.string().trim().max(max).nullish().transform((v) => v || null);
const zSupplier = z.object({
    name: z.string().trim().min(2, "Enter the supplier's name").max(120),
    phone: zText(40), email: zText(120), address: zText(300), notes: zText(500), active: z.boolean().optional(),
});
const zPrice = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().finite().min(0).max(10_000_000).nullable()).optional();
const zPoLines = z.array(z.object({ itemId: z.string().trim().min(1), qty: z.coerce.number().finite().positive("Quantities must be greater than zero").max(1_000_000), unitPrice: zPrice }))
    .min(1, "Add at least one item").max(300);
/** A purchase order; its prices (each line's unitPrice and the total) only for those who purchase (`stock.purchase`). */
function poView(id, prices = true) {
    const d = db();
    const po = d.get(`SELECT p.id, p.supplier_id AS "supplierId", s.name AS "supplierName", p.location_id AS "locationId", l.name AS "locationName", p.status, p.reference, p.note,
       p.created_at AS "createdAt", u.display_name AS "createdBy", p.sent_at AS "sentAt", p.closed_at AS "closedAt"
     FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id JOIN locations l ON l.id = p.location_id LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`, [id]);
    if (!po)
        throw notFound("Purchase order");
    const lines = d.all(`SELECT pl.id, pl.item_id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, pl.qty, pl.unit_price AS "unitPrice", pl.received_qty AS "receivedQty"
     FROM purchase_order_lines pl JOIN items i ON i.id = pl.item_id WHERE pl.po_id = ? ORDER BY pl.id`, [id]);
    if (!prices)
        return { ...po, lines: lines.map(({ unitPrice, ...l }) => l) };
    const total = lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);
    return { ...po, lines, total: Math.round(total * 100) / 100 };
}
function ownPo(req, id) {
    const po = poView(id, can(req.ctx, "stock.purchase"));
    if (po.locationId !== req.ctx.locationId && !can(req.ctx, "pharmacies.all"))
        throw notFound("Purchase order");
    return po;
}
export default async function routes(app) {
    // ---- suppliers
    app.get("/suppliers", async () => db().all("SELECT id, name, phone, email, address, notes, active, created_at AS \"createdAt\" FROM suppliers ORDER BY active DESC, name COLLATE NOCASE")
        .map((s) => ({ ...s, active: !!s.active })));
    app.post("/suppliers", async (req) => {
        requirePerm(req, "stock.purchase");
        const b = parse(zSupplier, req.body);
        if (db().get("SELECT 1 FROM suppliers WHERE name = ?", [b.name]))
            throw new HttpError(409, "A supplier with this name already exists");
        const id = db().run("INSERT INTO suppliers(name, phone, email, address, notes, active, created_at) VALUES (?,?,?,?,?,?,?)", [b.name, b.phone, b.email, b.address, b.notes, b.active === false ? 0 : 1, nowIso()]).lastId;
        audit(req, "supplier.create", "supplier", id, b);
        return { id };
    });
    app.put("/suppliers/:id", async (req) => {
        requirePerm(req, "stock.purchase");
        const id = parse(zId, req.params.id);
        const b = parse(zSupplier, req.body);
        if (!db().get("SELECT 1 FROM suppliers WHERE id = ?", [id]))
            throw notFound("Supplier");
        if (db().get("SELECT 1 FROM suppliers WHERE name = ? AND id <> ?", [b.name, id]))
            throw new HttpError(409, "A supplier with this name already exists");
        db().run("UPDATE suppliers SET name=?, phone=?, email=?, address=?, notes=?, active=? WHERE id=?", [b.name, b.phone, b.email, b.address, b.notes, b.active === false ? 0 : 1, id]);
        audit(req, "supplier.update", "supplier", id, b);
        return { ok: true };
    });
    // ---- purchase orders (of the session pharmacy)
    app.get("/orders", async (req) => {
        const q = parse(z.object({ open: z.coerce.number().optional() }), req.query);
        // prices and stock value are purchasing's (stock.purchase): others see the orders without their totals
        const prices = can(req.ctx, "stock.purchase");
        return db().all(`SELECT p.id, s.name AS "supplierName", p.status, p.reference, p.created_at AS "createdAt", p.sent_at AS "sentAt",
         (SELECT COUNT(*) FROM purchase_order_lines pl WHERE pl.po_id = p.id) AS "lineCount"
         ${prices ? `, (SELECT ROUND(SUM(COALESCE(pl.unit_price,0) * pl.qty), 2) FROM purchase_order_lines pl WHERE pl.po_id = p.id) AS total` : ""}
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.location_id = ? ${q.open ? "AND p.status IN ('draft','sent','partial')" : ""}
       ORDER BY CASE p.status WHEN 'draft' THEN 0 WHEN 'sent' THEN 1 WHEN 'partial' THEN 2 ELSE 3 END, p.id DESC LIMIT 300`, [req.ctx.locationId]);
    });
    app.get("/orders/:id", async (req) => ownPo(req, parse(zId, req.params.id)));
    app.post("/orders", async (req) => {
        requirePerm(req, "stock.purchase");
        const b = parse(z.object({ supplierId: zId, reference: zText(100), note: zText(500), lines: zPoLines }), req.body);
        const d = db();
        if (!d.get("SELECT 1 FROM suppliers WHERE id = ? AND active = 1", [b.supplierId]))
            throw bad("Choose an active supplier");
        const id = d.tx(() => {
            const id = d.run("INSERT INTO purchase_orders(supplier_id, location_id, status, reference, note, created_by, created_at) VALUES (?,?,'draft',?,?,?,?)", [b.supplierId, req.ctx.locationId, b.reference, b.note, req.ctx.userId, nowIso()]).lastId;
            for (const l of b.lines) {
                if (!d.get("SELECT 1 FROM items WHERE id = ?", [l.itemId]))
                    throw bad(`Item ${l.itemId} not found`);
                d.run("INSERT INTO purchase_order_lines(po_id, item_id, qty, unit_price) VALUES (?,?,?,?)", [id, l.itemId, round3(l.qty), l.unitPrice ?? null]);
            }
            return id;
        });
        audit(req, "po.create", "purchase_order", id, { supplierId: b.supplierId, lines: b.lines.length });
        return poView(id);
    });
    /** Change a draft (supplier, reference, lines replaced). */
    app.put("/orders/:id", async (req) => {
        requirePerm(req, "stock.purchase");
        const id = parse(zId, req.params.id);
        const po = ownPo(req, id);
        if (po.status !== "draft")
            throw new HttpError(409, "Only a draft can be changed");
        const b = parse(z.object({ supplierId: zId, reference: zText(100), note: zText(500), lines: zPoLines }), req.body);
        const d = db();
        if (!d.get("SELECT 1 FROM suppliers WHERE id = ? AND active = 1", [b.supplierId]))
            throw bad("Choose an active supplier");
        for (const l of b.lines)
            if (!d.get("SELECT 1 FROM items WHERE id = ?", [l.itemId]))
                throw bad(`Item ${l.itemId} not found`);
        d.tx(() => {
            d.run("UPDATE purchase_orders SET supplier_id = ?, reference = ?, note = ? WHERE id = ?", [b.supplierId, b.reference, b.note, id]);
            d.run("DELETE FROM purchase_order_lines WHERE po_id = ?", [id]);
            for (const l of b.lines)
                d.run("INSERT INTO purchase_order_lines(po_id, item_id, qty, unit_price) VALUES (?,?,?,?)", [id, l.itemId, round3(l.qty), l.unitPrice ?? null]);
        });
        audit(req, "po.update", "purchase_order", id, { lines: b.lines.length });
        return poView(id);
    });
    for (const [path, from, to] of [["send", ["draft"], "sent"], ["cancel", ["draft", "sent"], "cancelled"], ["close", ["partial"], "received"]]) {
        app.post(`/orders/:id/${path}`, async (req) => {
            requirePerm(req, "stock.purchase");
            const id = parse(zId, req.params.id);
            const po = ownPo(req, id);
            if (!from.includes(po.status))
                throw new HttpError(409, `A ${po.status} purchase order cannot be ${to === "sent" ? "sent" : to === "cancelled" ? "cancelled" : "closed"}`);
            db().run(`UPDATE purchase_orders SET status = ?, ${to === "sent" ? "sent_at" : "closed_at"} = ? WHERE id = ?`, [to, nowIso(), id]);
            audit(req, `po.${path}`, "purchase_order", id);
            return poView(id);
        });
    }
    // ---- returns to a supplier
    app.post("/returns", async (req) => {
        requirePerm(req, "stock.purchase");
        const b = parse(z.object({ batchId: zId, supplierId: zId, qty: z.coerce.number().finite().positive("Quantity must be greater than zero").max(1_000_000),
            reason: z.string().trim().min(3, "Give the reason").max(300), reference: zText(100) }), req.body);
        const d = db();
        const batch = d.get("SELECT location_id, is_placeholder, qty, batch_no FROM batches WHERE id = ?", [b.batchId]);
        if (!batch)
            throw notFound("Batch");
        if (batch.location_id !== req.ctx.locationId && !can(req.ctx, "pharmacies.all"))
            throw new HttpError(403, "You can only return your own pharmacy's stock");
        if (batch.is_placeholder)
            throw bad("Temporary (TEMP) stock cannot be returned");
        if (!d.get("SELECT 1 FROM suppliers WHERE id = ?", [b.supplierId]))
            throw bad("Choose the supplier");
        const id = d.tx(() => {
            const id = d.run("INSERT INTO supplier_returns(supplier_id, location_id, batch_id, qty, reason, reference, at, user_id) VALUES (?,?,?,?,?,?,?,?)", [b.supplierId, batch.location_id, b.batchId, round3(b.qty), b.reason, b.reference, nowIso(), req.ctx.userId]).lastId;
            move(d, b.batchId, "supplier_return", -round3(b.qty), req.ctx.userId, `Returned to supplier: ${b.reason}`, nowIso(), `supplier_return:${id}`);
            return id;
        });
        audit(req, "stock.supplier_return", "batch", b.batchId, { returnId: id, supplierId: b.supplierId, qty: b.qty, reason: b.reason });
        return { id };
    });
    app.get("/returns", async (req) => db().all(`SELECT r.id, r.at, s.name AS "supplierName", i.name AS "itemName", i.selection_name AS "selectionName", b.batch_no AS "batchNo", b.expiry_date AS expiry,
       r.qty, r.reason, r.reference, u.display_name AS "user"
     FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN batches b ON b.id = r.batch_id JOIN items i ON i.id = b.item_id LEFT JOIN users u ON u.id = r.user_id
     WHERE r.location_id = ? ORDER BY r.at DESC LIMIT 500`, [req.ctx.locationId]));
    // ---- value of the stock
    /** Usable stock × cost per item (the batch's cost, else the item's latest price), and what has no price. */
    app.get("/value", async (req) => {
        requirePerm(req, "stock.purchase");
        const q = parse(z.object({ all: z.coerce.number().optional() }), req.query);
        const all = !!q.all && can(req.ctx, "pharmacies.all");
        const t = toLocalDate(clockNow());
        const rows = db().all(`SELECT i.id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, i.class,
         ROUND(SUM(b.qty), 3) AS qty, ROUND(SUM(b.qty * COALESCE(b.unit_cost, i.unit_price)), 2) AS value,
         SUM(CASE WHEN COALESCE(b.unit_cost, i.unit_price) IS NULL THEN b.qty ELSE 0 END) AS "unpricedQty"
       FROM batches b JOIN items i ON i.id = b.item_id
       WHERE ${all ? "1=1" : "b.location_id = :l"} AND b.qty > 0 AND b.is_placeholder = 0 AND (b.expiry_date IS NULL OR b.expiry_date >= :t) AND NOT ${heldSql("b")}
       GROUP BY i.id ORDER BY value DESC NULLS LAST, i.name`, { l: req.ctx.locationId, t });
        const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
        return { total: Math.round(total * 100) / 100, items: rows.length, unpriced: rows.filter((r) => r.unpricedQty > 0).length, rows };
    });
}
