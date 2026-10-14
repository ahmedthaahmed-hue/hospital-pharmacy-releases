import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, HttpError, notFound, parse, requireWrite, zDate } from "../../lib/http.js";
import { round3 } from "../../core/schedule.js";
import * as S from "./service.js";
function checkLocation(id) {
    if (!db().get("SELECT 1 FROM locations WHERE id=?", [id]))
        throw new HttpError(404, "Pharmacy not found");
    return id;
}
/** Pharmacy to read: ?locationId= (admins/pharmacists) or the session pharmacy. */
export function readLocation(req, explicit) {
    const raw = explicit ?? req.query?.locationId;
    if (raw === undefined || raw === "" || raw === null)
        return req.ctx.locationId;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0)
        throw new HttpError(400, "Invalid pharmacy ID");
    if (id !== req.ctx.locationId && req.ctx.role === "viewer")
        throw new HttpError(403, "You cannot view another pharmacy's stock");
    return checkLocation(id);
}
/** Pharmacy to change: body/query locationId (admins only for another pharmacy) or the session pharmacy. */
export function writeLocation(req, requested) {
    requireWrite(req);
    const raw = requested ?? req.query?.locationId;
    const id = raw === undefined || raw === null || raw === "" ? req.ctx.locationId : Number(raw);
    if (!Number.isInteger(id) || id <= 0)
        throw new HttpError(400, "Invalid pharmacy ID");
    if (id !== req.ctx.locationId && req.ctx.role !== "admin")
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
        requireWrite(req); // before validating: a viewer is told it is read-only, not what to fix in the form
        const body = parse(z.object({
            locationId: z.coerce.number().int().optional().nullable(),
            reference: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
            lines: z.array(z.object({
                itemId: z.string({ error: "Choose the item" }).trim().min(1, "Choose the item"),
                batchNo: z.string({ error: "Enter the batch no." }).trim().min(1, "Enter the batch no.").max(60, "Batch no. is too long"),
                expiry: zDate,
                qty: zQty(),
            })).min(1, "Add at least one line").max(200, "Too many lines"),
        }), req.body);
        const loc = writeLocation(req, body.locationId);
        const note = body.reference ? `Received: ${body.reference}` : "Received";
        const lines = S.receive(db(), loc, body.lines, req.ctx.userId, note);
        audit(req, "stock.receive", "location", loc, { reference: body.reference, lines: lines.map((l) => ({ batchId: l.batchId, itemId: l.itemId, batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, created: l.created })) });
        return { locationId: loc, lines, totalQty: round3(lines.reduce((s, l) => s + l.qty, 0)) };
    });
    /** Correct one batch quantity (count correction / write-off). Reason required. Refuses if the batch moved since loaded. */
    app.post("/batches/:id/adjust", async (req) => {
        requireWrite(req);
        const b = batchOrThrow(parse(zBatchId, req.params.id));
        writeLocation(req, b.locationId);
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
        requireWrite(req);
        const body = parse(z.object({
            locationId: z.coerce.number().int().optional().nullable(),
            reason: zReason,
            lines: z.array(z.object({ batchId: zBatchId, countedQty: zQty(zNum.min(0, "Counted quantity cannot be negative")),
                // what the sheet showed: a negative one would add stock (difference = counted − expected)
                expectedQty: zQty(zNum.min(0, "Invalid quantity")) }))
                .min(1, "No counted quantities").max(5000),
        }), req.body);
        const loc = writeLocation(req, body.locationId);
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
        const loc = writeLocation(req, body.locationId);
        const r = S.createPlaceholders(db(), loc, req.ctx.userId);
        audit(req, "stock.placeholders_create", "location", loc, r);
        return r;
    });
    /** Remove all TEMP stock at the pharmacy (quantity → 0, logged). Idempotent. */
    app.post("/placeholders/delete", async (req) => {
        const body = parse(z.object({ locationId: z.coerce.number().int().optional().nullable() }), req.body ?? {});
        const loc = writeLocation(req, body.locationId);
        const r = S.removePlaceholders(db(), loc, req.ctx.userId);
        audit(req, "stock.placeholders_delete", "location", loc, r);
        return r;
    });
    /** Batches whose quantity disagrees with their ledger (should be empty). */
    app.get("/reconcile", async (req) => {
        const loc = readLocation(req);
        const rows = S.reconcile(db(), loc);
        return { locationId: loc, ok: rows.length === 0, rows };
    });
}
