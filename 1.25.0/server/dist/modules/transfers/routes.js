import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, parse, requirePerm, zId } from "../../lib/http.js";
import { addDays, nowIso, now as clockNow, parseLocal, toLocalDate } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { heldSql } from "../../core/fefo.js";
import * as T from "./service.js";
const zQty = z.coerce.number({ error: "Quantity must be a number" }).finite().positive("Quantities must be greater than zero").max(1_000_000);
const zLines = z.array(z.object({ itemId: z.string().trim().min(1, "Choose the item"), qty: zQty })).min(1, "Add at least one item").max(300);
const zNote = z.string().trim().max(500).nullish().transform((v) => v || null);
const anyPharmacy = (req) => can(req.ctx, "pharmacies.all");
/** The pharmacy acting: the session's, or another one for "Work in any pharmacy". */
function acting(req, requested) {
    if (requested == null || requested === req.ctx.locationId)
        return req.ctx.locationId;
    if (!anyPharmacy(req))
        throw new HttpError(403, "You can only act for your own pharmacy");
    return requested;
}
function mustBe(req, locationId, what) {
    if (locationId !== req.ctx.locationId && !anyPharmacy(req))
        throw new HttpError(403, what);
}
const usableSql = (alias) => `${alias}.qty > 0 AND ${alias}.is_placeholder = 0 AND (${alias}.expiry_date IS NULL OR ${alias}.expiry_date >= :t) AND NOT ${heldSql(alias)}`;
export default async function routes(app) {
    app.get("/", async (req) => {
        const q = parse(z.object({ side: z.enum(["in", "out"]).optional(), open: z.coerce.number().optional(), locationId: z.coerce.number().int().positive().optional() }), req.query);
        let loc = req.ctx.locationId;
        if (q.locationId && q.locationId !== loc) {
            if (!can(req.ctx, "other_pharmacies") && !anyPharmacy(req))
                throw new HttpError(403, "You can only see your own pharmacy's transfers");
            loc = q.locationId;
        }
        return T.listTransfers(db(), loc, { side: q.side, open: !!q.open });
    });
    app.get("/:id", async (req) => {
        const t = T.getTransfer(db(), parse(zId, req.params.id));
        if (![t.fromLocationId, t.toLocationId].includes(req.ctx.locationId) && !can(req.ctx, "other_pharmacies") && !anyPharmacy(req))
            throw new HttpError(404, "Transfer not found");
        return t;
    });
    /** Ask another pharmacy (or the main store) for items. */
    app.post("/", async (req) => {
        requirePerm(req, "stock.transfer");
        const b = parse(z.object({ fromLocationId: zId, toLocationId: z.coerce.number().int().positive().nullish(), lines: zLines, note: zNote }), req.body);
        const to = acting(req, b.toLocationId);
        const id = T.createRequest(db(), { from: b.fromLocationId, to, lines: b.lines, note: b.note, userId: req.ctx.userId });
        audit(req, "transfer.request", "transfer", id, { from: b.fromLocationId, to, lines: b.lines });
        return T.getTransfer(db(), id);
    });
    /** Send stock to another pharmacy without a request (issued at once; it receives it). */
    app.post("/send", async (req) => {
        requirePerm(req, "stock.transfer");
        const b = parse(z.object({ toLocationId: zId, fromLocationId: z.coerce.number().int().positive().nullish(), note: zNote,
            lines: z.array(z.object({ itemId: z.string().trim().min(1, "Choose the item"), qty: zQty, batchNo: z.string().trim().max(60).nullish() })).min(1, "Add at least one item").max(300) }), req.body);
        const from = acting(req, b.fromLocationId);
        const prefer = new Map(b.lines.filter((l) => l.batchNo).map((l) => [l.itemId, l.batchNo]));
        const id = db().tx(() => {
            const id = T.createRequest(db(), { from, to: b.toLocationId, lines: b.lines.map(({ itemId, qty }) => ({ itemId, qty })), note: b.note, userId: req.ctx.userId, kind: "send" });
            T.issue(db(), id, null, req.ctx.userId, prefer);
            return id;
        });
        audit(req, "transfer.send", "transfer", id, { from, to: b.toLocationId, lines: b.lines });
        return T.getTransfer(db(), id);
    });
    app.post("/:id/issue", async (req) => {
        requirePerm(req, "stock.transfer");
        const id = parse(zId, req.params.id);
        const t = T.getTransfer(db(), id);
        mustBe(req, t.fromLocationId, "Only the pharmacy asked can issue this request");
        const b = parse(z.object({ lines: z.array(z.object({ lineId: zId, qty: z.coerce.number().finite().min(0).max(1_000_000) })).max(300).optional() }), req.body ?? {});
        T.issue(db(), id, b.lines ? new Map(b.lines.map((l) => [l.lineId, l.qty])) : null, req.ctx.userId);
        audit(req, "transfer.issue", "transfer", id, b);
        return T.getTransfer(db(), id);
    });
    app.post("/:id/receive", async (req) => {
        requirePerm(req, "stock.transfer");
        const id = parse(zId, req.params.id);
        const t = T.getTransfer(db(), id);
        mustBe(req, t.toLocationId, "Only the receiving pharmacy can receive this transfer");
        T.receive(db(), id, req.ctx.userId);
        audit(req, "transfer.receive", "transfer", id);
        return T.getTransfer(db(), id);
    });
    for (const [path, how, side, msg] of [["cancel", "cancelled", "to", "Only the pharmacy that asked can cancel its request"],
        ["reject", "rejected", "from", "Only the pharmacy asked can reject this request"],
        ["refuse", "refused", "to", "Only the receiving pharmacy can refuse this transfer"]]) {
        app.post(`/:id/${path}`, async (req) => {
            requirePerm(req, "stock.transfer");
            const id = parse(zId, req.params.id);
            const t = T.getTransfer(db(), id);
            mustBe(req, side === "to" ? t.toLocationId : t.fromLocationId, msg);
            const { note } = parse(z.object({ note: zNote }), req.body ?? {});
            T.close(db(), id, how, note, req.ctx.userId);
            audit(req, `transfer.${path}`, "transfer", id, { note });
            return T.getTransfer(db(), id);
        });
    }
    // ---- minimum / maximum levels
    /** Items with a level at this pharmacy, or ?all=1 every stocked item, with what is usable and on its way. */
    app.get("/levels", async (req) => {
        const q = parse(z.object({ all: z.coerce.number().optional(), locationId: z.coerce.number().int().positive().optional() }), req.query);
        const loc = q.locationId && q.locationId !== req.ctx.locationId && (can(req.ctx, "other_pharmacies") || anyPharmacy(req)) ? q.locationId : req.ctx.locationId;
        return levelRows(loc, !!q.all);
    });
    app.put("/levels/:itemId", async (req) => {
        requirePerm(req, "stock.transfer");
        const itemId = String(req.params.itemId);
        const n = z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().finite().min(0).max(1_000_000).nullable());
        const b = parse(z.object({ min: n, max: n, locationId: z.coerce.number().int().positive().nullish() }), req.body);
        const loc = acting(req, b.locationId);
        if (!db().get("SELECT 1 FROM items WHERE id = ?", [itemId]))
            throw new HttpError(404, "Item not found");
        if (b.min != null && b.max != null && b.max < b.min)
            throw new HttpError(400, "The maximum must not be below the minimum");
        if (b.min == null && b.max == null)
            db().run("DELETE FROM stock_levels WHERE item_id = ? AND location_id = ?", [itemId, loc]);
        else
            db().run(`INSERT INTO stock_levels(item_id, location_id, min_qty, max_qty, updated_at) VALUES (?,?,?,?,?)
                   ON CONFLICT(item_id, location_id) DO UPDATE SET min_qty = excluded.min_qty, max_qty = excluded.max_qty, updated_at = excluded.updated_at`, [itemId, loc, b.min, b.max, nowIso()]);
        audit(req, "stock.level", "item", itemId, { locationId: loc, min: b.min, max: b.max });
        return { ok: true };
    });
    /**
     * What to ask for: items below their minimum here, topped up to the maximum (twice the minimum without one), less what
     * is already asked for or on its way; with what the chosen source pharmacy has usable.
     */
    app.get("/suggestions", async (req) => {
        const q = parse(z.object({ fromLocationId: z.coerce.number().int().positive().optional() }), req.query);
        const rows = levelRows(req.ctx.locationId, false).filter((r) => r.min != null && r.usable < r.min);
        const t = toLocalDate(clockNow());
        return rows.map((r) => {
            const target = r.max ?? r.min * 2;
            const qty = round3(Math.max(0, target - r.usable - r.incoming));
            const atSource = q.fromLocationId ? round3(db().get(`SELECT COALESCE(SUM(b.qty),0) q FROM batches b WHERE b.item_id = :i AND b.location_id = :l AND ${usableSql("b")}`, { i: r.itemId, l: q.fromLocationId, t }).q) : null;
            return { ...r, suggested: qty, atSource };
        }).filter((r) => r.suggested > 0);
    });
    /**
     * Near-expiry stock here that this pharmacy will not use in time (at its use over the last 30 days), and the
     * pharmacies that would: their use before the expiry date covers it.
     */
    app.get("/redistribution", async (req) => {
        const q = parse(z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }), req.query);
        const d = db();
        const t = toLocalDate(clockNow());
        const until = toLocalDate(addDays(parseLocal(t), q.days));
        const since = toLocalDate(addDays(parseLocal(t), -30));
        const batches = d.all(`SELECT b.id, b.item_id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, b.batch_no AS "batchNo", b.expiry_date AS expiry, b.qty
       FROM batches b JOIN items i ON i.id = b.item_id
       WHERE b.location_id = :l AND ${usableSql("b")} AND b.expiry_date IS NOT NULL AND b.expiry_date <= :u ORDER BY b.expiry_date`, { l: req.ctx.locationId, t, u: until });
        const useRate = (itemId, loc) => (d.get(`SELECT COALESCE(SUM(CASE WHEN type = 'return' THEN -qty ELSE qty END), 0) q FROM dispenses WHERE item_id = ? AND location_id = ? AND at >= ?`, [itemId, loc, since]).q) / 30;
        const locations = d.all("SELECT id, name FROM locations WHERE active = 1 AND id <> ?", [req.ctx.locationId]);
        const out = [];
        for (const b of batches) {
            const days = Math.max(0, Math.round((parseLocal(b.expiry).getTime() - parseLocal(t).getTime()) / 86_400_000));
            const here = useRate(b.itemId, req.ctx.locationId);
            const usedHere = here * days;
            const surplus = round3(b.qty - usedHere);
            if (surplus <= 0)
                continue;
            const elsewhere = locations.map((l) => {
                const rate = useRate(b.itemId, l.id);
                return { locationId: l.id, name: l.name, perDay: round3(rate), canUse: round3(Math.min(surplus, rate * days)) };
            }).filter((x) => x.canUse > 0).sort((a, z2) => z2.canUse - a.canUse).slice(0, 3);
            out.push({ ...b, daysLeft: days, perDayHere: round3(here), surplus, elsewhere });
        }
        return out;
    });
}
/** Levels and usable stock of a pharmacy: items with a level (or every item it stocks, all). */
function levelRows(loc, all) {
    const t = toLocalDate(clockNow());
    return db().all(`SELECT i.id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, s.min_qty AS min, s.max_qty AS max,
       (SELECT COALESCE(SUM(b.qty),0) FROM batches b WHERE b.item_id = i.id AND b.location_id = :l AND ${usableSql("b")}) AS usable,
       (SELECT COALESCE(SUM(CASE WHEN t.status = 'issued' THEN l.qty_issued ELSE l.qty_requested END),0) FROM transfer_lines l JOIN transfers t ON t.id = l.transfer_id
          WHERE l.item_id = i.id AND t.to_location_id = :l AND t.status IN ('requested','issued')) AS incoming
     FROM items i LEFT JOIN stock_levels s ON s.item_id = i.id AND s.location_id = :l
     WHERE i.active = 1 AND (s.item_id IS NOT NULL ${all ? "OR EXISTS (SELECT 1 FROM batches b WHERE b.item_id = i.id AND b.location_id = :l AND b.is_placeholder = 0)" : ""})
     ORDER BY i.name COLLATE NOCASE`, { l: loc, t }).map((r) => ({ ...r, usable: round3(r.usable), incoming: round3(r.incoming),
        below: r.min != null && r.usable < r.min }));
}
