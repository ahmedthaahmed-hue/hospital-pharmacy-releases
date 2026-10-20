import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, notFound, parse, requirePerm, zDate } from "../../lib/http.js";
import { round3 } from "../../core/schedule.js";
import * as S from "./service.js";
import * as H from "./holds.js";
import { planFEFO } from "../../core/fefo.js";
function checkLocation(id) {
    if (!db().get("SELECT 1 FROM locations WHERE id=?", [id]))
        throw new HttpError(404, "Pharmacy not found");
    return id;
}
/** Pharmacy to read: ?locationId= (with "See other pharmacies") or the session pharmacy. */
export function readLocation(req, explicit) {
    const raw = explicit ?? req.query?.locationId;
    if (raw === undefined || raw === "" || raw === null)
        return req.ctx.locationId;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0)
        throw new HttpError(400, "Invalid pharmacy ID");
    if (id !== req.ctx.locationId && !can(req.ctx, "other_pharmacies") && !can(req.ctx, "pharmacies.all"))
        throw new HttpError(403, "You cannot view another pharmacy's stock");
    return checkLocation(id);
}
/**
 * Pharmacy to change: body/query locationId (only with "Work in any pharmacy" for another pharmacy) or the session
 * pharmacy. `perm`: receiving, or counts / adjustments / TEMP stock.
 */
export function writeLocation(req, requested, perm) {
    requirePerm(req, perm);
    const raw = requested ?? req.query?.locationId;
    const id = raw === undefined || raw === null || raw === "" ? req.ctx.locationId : Number(raw);
    if (!Number.isInteger(id) || id <= 0)
        throw new HttpError(400, "Invalid pharmacy ID");
    if (id !== req.ctx.locationId && !can(req.ctx, "pharmacies.all"))
        throw new HttpError(403, "You can only change your own pharmacy's stock");
    return checkLocation(id);
}
// z.coerce alone turns null / "" into 0, so a blank counted or new quantity would silently zero the batch.
// Same ceiling as dispensing / returns: beyond it a typo turns the batch into Infinity (and every later change into a 500).
const zNum = z.coerce.number({ error: "Quantity must be a number" }).finite("Invalid quantity").max(1_000_000, "Quantity is too large");
// true / [] would coerce to 1 / 0 (an adjust to [] zeroed the batch): only numbers and numeric text are quantities.
const zQty = (n = zNum) => z.preprocess((v) => (v === null || (typeof v === "string" && v.trim() === "") || (typeof v !== "number" && typeof v !== "string") ? undefined : v), n);
const zReason = z.string({ error: "Enter the reason for the change" }).trim().min(3, "Enter the reason for the change (at least 3 characters)").max(300, "The reason is too long");
const zBatchId = z.coerce.number().int().positive();
function batchOrThrow(id) {
    const b = S.getBatch(db(), id);
    if (!b)
        throw new HttpError(404, "Batch not found");
    return b;
}
/** May see other pharmacies' stock (holds show each pharmacy's quantity only to them). */
const seesOthers = (req) => can(req.ctx, "other_pharmacies") || can(req.ctx, "pharmacies.all");
export default async function routes(app) {
    /** Per-item stock at a pharmacy: usable / expired / TEMP, nearest expiry, batch count, low/out/expiring flags. */
    app.get("/overview", async (req) => {
        const loc = readLocation(req);
        const q = String(req.query.q ?? "").trim().toLowerCase();
        const filter = String(req.query.filter ?? "");
        let rows = S.overview(db(), loc);
        if (q)
            rows = rows.filter((r) => [r.name, r.selectionName, r.itemId].some((v) => v?.toLowerCase().includes(q)));
        if (filter === "stocked")
            rows = rows.filter((r) => r.total > 0);
        else if (filter === "low")
            rows = rows.filter((r) => r.low);
        else if (filter === "out")
            rows = rows.filter((r) => r.out);
        else if (filter === "expired")
            rows = rows.filter((r) => r.expired > 0);
        else if (filter === "expiring")
            rows = rows.filter((r) => r.expiring);
        else if (filter === "temp")
            rows = rows.filter((r) => r.tempUsed > 0);
        else if (filter === "held")
            rows = rows.filter((r) => r.held > 0);
        return { locationId: loc, lowThreshold: S.lowThreshold(db()), expiryWarnDays: S.expiryWarnDays(db()), rows };
    });
    /** Batches of an item at a pharmacy (FEFO order; TEMP last). ?includeEmpty=1 to include zero-qty batches. */
    app.get("/items/:itemId/batches", async (req) => {
        const loc = readLocation(req);
        const item = db().get(`SELECT id, name, selection_name AS "selectionName", unit, active FROM items WHERE id=?`, [req.params.itemId]);
        if (!item)
            throw notFound("Item");
        return { item, locationId: loc, batches: S.itemBatches(db(), item.id, loc, req.query.includeEmpty === "1") };
    });
    /** Recent movements of an item at a pharmacy (newest first). */
    app.get("/items/:itemId/movements", async (req) => {
        const loc = readLocation(req);
        const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 1000);
        return S.itemLedger(db(), req.params.itemId, loc, limit);
    });
    app.get("/batches/:id", async (req) => {
        const b = batchOrThrow(parse(zBatchId, req.params.id));
        readLocation(req, b.locationId);
        return b;
    });
    /** Ledger of a batch with running balance (oldest first). */
    app.get("/batches/:id/movements", async (req) => {
        const b = batchOrThrow(parse(zBatchId, req.params.id));
        readLocation(req, b.locationId);
        return { batch: b, ...S.batchLedger(db(), b.id) };
    });
    /** Receive stock: several lines in one submission. Adds to an existing batch with the same item+batch+expiry, else creates it. */
    app.post("/receive", async (req) => {
        requirePerm(req, "stock.receive"); // before validating: someone without it is told so, not what to fix in the form
        const body = parse(z.object({
            locationId: z.coerce.number().int().optional().nullable(),
            reference: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
            lines: z.array(z.object({
                itemId: z.string({ error: "Choose the item" }).trim().min(1, "Choose the item"),
                batchNo: z.string({ error: "Enter the batch no." }).trim().min(1, "Enter the batch no.").max(60, "Batch no. is too long"),
                expiry: zDate,
                qty: zQty(),
                unitPrice: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number({ error: "Price must be a number" }).finite().min(0, "Price cannot be negative").max(10_000_000).nullable()).optional(),
                poLineId: z.coerce.number().int().positive().nullish(),
            })).min(1, "Add at least one line").max(200, "Too many lines"),
            poId: z.coerce.number().int().positive().nullish(),
        }), req.body);
        const loc = writeLocation(req, body.locationId, "stock.receive");
        const note = body.reference ? `Received: ${body.reference}` : "Received";
        // a price changes the item's cost in every pharmacy: purchasing's to set
        if (body.poId || body.lines.some((l) => l.unitPrice != null))
            requirePerm(req, "stock.purchase");
        const lines = S.receive(db(), loc, body.lines, req.ctx.userId, note, body.poId ?? null);
        audit(req, "stock.receive", "location", loc, { reference: body.reference, lines: lines.map((l) => ({ batchId: l.batchId, itemId: l.itemId, batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, created: l.created })) });
        return { locationId: loc, lines, totalQty: round3(lines.reduce((s, l) => s + l.qty, 0)) };
    });
    /** Correct one batch quantity (count correction / write-off). Reason required. Refuses if the batch moved since loaded. */
    app.post("/batches/:id/adjust", async (req) => {
        requirePerm(req, "stock.adjust");
        const b = batchOrThrow(parse(zBatchId, req.params.id));
        writeLocation(req, b.locationId, "stock.adjust");
        const body = parse(z.object({
            newQty: zQty(zNum.min(0, "Quantity cannot be negative")),
            expectedQty: zQty().optional().nullable(),
            reason: zReason,
        }), req.body);
        const r = S.adjust(db(), b.id, body.newQty, body.expectedQty ?? null, body.reason, req.ctx.userId);
        audit(req, "stock.adjust", "batch", b.id, { ...r, itemId: b.itemId, batchNo: b.batchNo, locationId: b.locationId, reason: body.reason });
        return { ...r, batch: S.getBatch(db(), b.id) };
    });
    /** Count sheet: real batches at the pharmacy. */
    app.get("/count-sheet", async (req) => {
        const loc = readLocation(req);
        return S.countSheet(db(), loc, req.query.includeEmpty === "1");
    });
    /** Apply a count: lines whose counted quantity differs from what the sheet showed become 'adjust' movements. */
    app.post("/count", async (req) => {
        requirePerm(req, "stock.adjust");
        const body = parse(z.object({
            locationId: z.coerce.number().int().optional().nullable(),
            reason: zReason,
            lines: z.array(z.object({ batchId: zBatchId, countedQty: zQty(zNum.min(0, "Counted quantity cannot be negative")),
                // what the sheet showed: a negative one would add stock (difference = counted − expected)
                expectedQty: zQty(zNum.min(0, "Invalid quantity")) }))
                .min(1, "No counted quantities").max(5000),
        }), req.body);
        const loc = writeLocation(req, body.locationId, "stock.adjust");
        const r = S.applyCount(db(), loc, body.lines, body.reason, req.ctx.userId);
        audit(req, "stock.count", "location", loc, { reason: body.reason, adjusted: r.adjusted, netDelta: r.netDelta, lines: r.lines });
        return r;
    });
    /** Real batches with stock expiring within ?days= (default: setting, 90). */
    app.get("/expiring", async (req) => {
        const loc = readLocation(req);
        const days = Math.min(Math.max(Number(req.query.days) || S.expiryWarnDays(db()), 1), 3650);
        return S.expiring(db(), loc, days);
    });
    /** Batches past expiry that still hold stock (to write off). */
    app.get("/expired", async (req) => S.expired(db(), readLocation(req)));
    /** TEMP placeholder status: coverage and items that were dispensed from TEMP (i.e. dispensed without real stock). */
    app.get("/placeholders", async (req) => {
        const loc = readLocation(req);
        return { locationId: loc, ...S.placeholderStatus(db(), loc), placeholder: S.PLACEHOLDER };
    });
    /** Create TEMP batches (XXX666 / 2099-12-31 / 1,000,000) for every active item lacking one. Idempotent. */
    app.post("/placeholders/create", async (req) => {
        const body = parse(z.object({ locationId: z.coerce.number().int().optional().nullable() }), req.body ?? {});
        const loc = writeLocation(req, body.locationId, "stock.adjust");
        const r = S.createPlaceholders(db(), loc, req.ctx.userId);
        audit(req, "stock.placeholders_create", "location", loc, r);
        return r;
    });
    /** Remove all TEMP stock at the pharmacy (quantity → 0, logged). Idempotent. */
    app.post("/placeholders/delete", async (req) => {
        const body = parse(z.object({ locationId: z.coerce.number().int().optional().nullable() }), req.body ?? {});
        const loc = writeLocation(req, body.locationId, "stock.adjust");
        const r = S.removePlaceholders(db(), loc, req.ctx.userId);
        audit(req, "stock.placeholders_delete", "location", loc, r);
        return r;
    });
    // ---- holds: quarantine at a pharmacy, recall of a lot in every pharmacy (holds.ts)
    /** Holds touching a pharmacy (its own quarantines and every recall); ?all=1 every hold (Work in any pharmacy). */
    app.get("/holds", async (req) => {
        const all = req.query.all === "1" && can(req.ctx, "pharmacies.all");
        const loc = all ? null : readLocation(req);
        return H.listHolds(db(), { active: req.query.active === "1", locationId: loc, stockAt: seesOthers(req) ? null : req.ctx.locationId });
    });
    app.post("/holds", async (req) => {
        requirePerm(req, "stock.adjust");
        const b = parse(z.object({
            itemId: z.string().trim().min(1, "Choose the item"),
            batchNo: z.string().trim().min(1, "Enter the batch no.").max(60, "Batch no. is too long"),
            kind: z.enum(["quarantine", "recall"], { message: "Choose quarantine or recall" }),
            reason: zReason,
            reference: z.string().trim().max(200).nullish().transform((v) => v || null),
            locationId: z.coerce.number().int().positive().nullish(),
        }), req.body);
        // a recall holds the lot in every pharmacy: only who works in any pharmacy; a quarantine is one pharmacy's
        let loc;
        if (b.kind === "recall") {
            requirePerm(req, "stock.adjust");
            if (!can(req.ctx, "pharmacies.all"))
                throw new HttpError(403, "A recall holds the lot in every pharmacy — ask someone who works in any pharmacy");
            loc = null;
        }
        else
            loc = writeLocation(req, b.locationId, "stock.adjust");
        const id = H.createHold(db(), { ...b, locationId: loc }, req.ctx.userId);
        audit(req, `stock.${b.kind}`, "batch_hold", id, { itemId: b.itemId, batchNo: b.batchNo, locationId: loc, reason: b.reason, reference: b.reference });
        return H.getHold(db(), id, seesOthers(req) ? null : req.ctx.locationId);
    });
    app.post("/holds/:id/release", async (req) => {
        requirePerm(req, "stock.adjust");
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0)
            throw new HttpError(400, "Invalid hold");
        const h = H.getHold(db(), id, req.ctx.locationId);
        if (h.locationId == null) {
            requirePerm(req, "stock.adjust");
            if (!can(req.ctx, "pharmacies.all"))
                throw new HttpError(403, "Only someone who works in any pharmacy can end a recall");
        }
        else
            writeLocation(req, h.locationId, "stock.adjust");
        const { note } = parse(z.object({ note: z.string().trim().max(300).nullish().transform((v) => v || null) }), req.body ?? {});
        H.releaseHold(db(), id, note, req.ctx.userId);
        audit(req, "stock.hold_release", "batch_hold", id, { note });
        return H.getHold(db(), id, seesOthers(req) ? null : req.ctx.locationId);
    });
    /** Who received the lot (a recall's patient list): its dispenses, and the patients with what they got. */
    app.get("/holds/:id/trace", async (req) => {
        requirePerm(req, "reports");
        const h = H.getHold(db(), Number(req.params.id), seesOthers(req) ? null : req.ctx.locationId);
        if (h.locationId != null && h.locationId !== req.ctx.locationId)
            readLocation(req, h.locationId);
        // a recall spans every pharmacy: its trace too, for those who may see them; others see their own pharmacy's part
        const wide = h.locationId == null && (can(req.ctx, "pharmacies.all") || can(req.ctx, "other_pharmacies"));
        return { hold: h, ...H.traceLot(db(), { itemId: h.itemId, batchNo: h.batchNo, locationId: wide ? null : h.locationId ?? req.ctx.locationId }) };
    });
    /** Batches FEFO would take each quantity from now (nothing is taken): the daily run's picking list. */
    app.post("/fefo-plan", async (req) => {
        requirePerm(req, "runs");
        const b = parse(z.object({ items: z.array(z.object({ itemId: z.string().trim().min(1), qty: zQty() })).max(1000) }), req.body);
        const loc = req.ctx.locationId;
        return b.items.map((i) => ({ itemId: i.itemId, qty: round3(i.qty), batches: planFEFO(db(), i.itemId, loc, i.qty) }));
    });
    /** Batches whose quantity disagrees with their ledger (should be empty). */
    app.get("/reconcile", async (req) => {
        const loc = readLocation(req);
        const rows = S.reconcile(db(), loc);
        return { locationId: loc, ok: rows.length === 0, rows };
    });
}
