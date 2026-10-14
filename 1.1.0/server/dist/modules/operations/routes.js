import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, HttpError, notFound, parse, requireWrite, zBool, zId } from "../../lib/http.js";
import { now as clockNow, nowIso, toHHMM, toLocalDate } from "../../lib/time.js";
import { ITEM_NAME, zItemId, zText } from "../walkin/shared.js";
import { patientInLocation } from "../patients/scope.js";
import { itemsDispensedTodayElsewhere, markEditedAfterDispense, scheduleSettings } from "../orders/view.js";
import { medicalDay } from "../../core/schedule.js";
export const KIT_NOTE = "(Auto from Operation Kit)"; // legacy modOperationsKits wording
const OP_SELECT = `SELECT o.id, o.op_no AS opNo, o.name, o.location_id AS locationId, o.active FROM operations o`;
/**
 * Visible at a pharmacy: its own operations, global ones (location NULL), and — so imported legacy kits stay usable —
 * operations of another pharmacy for which this pharmacy has a kit (legacy data has EMR kits on OP-pharmacy operations).
 */
const VISIBLE = `(o.location_id IS NULL OR o.location_id = :loc OR EXISTS (SELECT 1 FROM operation_kits vk WHERE vk.operation_id = o.id AND vk.location_id = :loc))`;
const OP_ORDER = `ORDER BY (o.op_no IS NULL OR o.op_no = ''), CAST(o.op_no AS REAL), o.op_no, o.name`;
/** Operation visible to this pharmacy (see VISIBLE). */
function loadOperation(d, id, locationId) {
    const o = d.get(`${OP_SELECT} WHERE o.id = :id AND ${VISIBLE}`, { id, loc: locationId });
    if (!o)
        throw notFound("Operation");
    return { ...o, active: !!o.active };
}
/** Pharmacists manage their own pharmacy's operations; global operations (all pharmacies) are admin-only. */
function canEditOperation(ctx, locationId) {
    if (ctx.role === "admin")
        return;
    if (locationId == null || locationId !== ctx.locationId)
        throw new HttpError(403, "Only an admin can edit operations shared by all pharmacies");
}
function kitOf(d, operationId, locationId) {
    const k = d.get("SELECT id, operation_id AS operationId, location_id AS locationId, active, notes FROM operation_kits WHERE operation_id = ? AND location_id = ?", [operationId, locationId]);
    if (!k)
        return null;
    const lines = d.all(`SELECT l.id, l.item_id AS itemId, ${ITEM_NAME} AS itemName, i.unit, i.strength, l.default_qty AS defaultQty, l.active,
            EXISTS (SELECT 1 FROM operation_kit_exclusions e WHERE e.location_id = ? AND e.item_id = l.item_id AND e.active = 1) AS excluded
     FROM operation_kit_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.kit_id = ? ORDER BY l.id`, [locationId, k.id]).map((l) => ({ ...l, active: !!l.active, excluded: !!l.excluded }));
    return { ...k, active: !!k.active, lines };
}
function loadKit(d, kitId, locationId) {
    const k = d.get("SELECT id, operation_id, location_id FROM operation_kits WHERE id = ?", [kitId]);
    if (!k || k.location_id !== locationId)
        throw notFound("Kit");
    return k;
}
function exclusions(d, locationId) {
    return d.all(`SELECT e.id, e.item_id AS itemId, ${ITEM_NAME} AS itemName, i.unit, e.active, e.reason
     FROM operation_kit_exclusions e LEFT JOIN items i ON i.id = e.item_id WHERE e.location_id = ? ORDER BY e.active DESC, itemName`, [locationId]).map((e) => ({ ...e, active: !!e.active }));
}
const itemExists = (d, id) => { if (!d.get("SELECT 1 FROM items WHERE id = ?", [id]))
    throw bad("Item not found in the items list"); };
/**
 * Apply the pharmacy's active kit of an operation to a patient (legacy ApplyOperationKitToPatient).
 * One single-dose 'operation' order per active kit line with qty > 0 that is not excluded at this pharmacy.
 */
export function applyKit(d, a) {
    return d.tx(() => {
        // the patient must belong to the session pharmacy (the kit deletes/inserts orders)
        const p = patientInLocation(d, a.patientId, a.locationId);
        if (!p.active)
            throw bad("Patient is inactive — restore them first");
        loadOperation(d, a.operationId, a.locationId);
        const kit = d.get("SELECT id FROM operation_kits WHERE operation_id = ? AND location_id = ? AND active = 1", [a.operationId, a.locationId]);
        if (!kit)
            throw bad("This operation has no active kit in this pharmacy");
        const lines = d.all(`SELECT l.item_id, ${ITEM_NAME} AS item_name, l.default_qty,
              EXISTS (SELECT 1 FROM operation_kit_exclusions e WHERE e.location_id = ? AND e.item_id = l.item_id AND e.active = 1) AS excluded
       FROM operation_kit_lines l JOIN items i ON i.id = l.item_id
       WHERE l.kit_id = ? AND l.active = 1 AND l.default_qty > 0 ORDER BY l.id`, [a.locationId, kit.id]);
        const now = a.now ?? clockNow(); // request clock: a kit applied offline and replayed keeps its real date/time
        const stamp = nowIso();
        // Applying a kit again (legacy: delete the auto orders, insert the kit again, dated now) handed the whole kit out a
        // second time: the fresh orders have undispensed doses, so the next run or mid-day dispense gave them without a word.
        // Decision (patient safety over the legacy replace):
        //  * items of this kit the patient already received today from an earlier kit order (or a deleted / stopped one):
        //    the apply is refused with needs_force (the web asks first). Once confirmed, the new orders for those items are
        //    marked as changed after dispense for today, so the run skips them and a mid-day dispense asks again — a second
        //    operation the same day is still possible, just never silently. (Recording the old slots on the new orders
        //    instead would claim dispenses those orders never had.) Other days run as usual.
        //  * a replaced kit order that was dispensed is never deleted (its dispensing history would lose its order): it is
        //    stopped instead. Only never-dispensed auto orders are deleted, as legacy did.
        const kitItems = [...new Set(lines.filter((l) => !l.excluded).map((l) => l.item_id))];
        const givenToday = itemsDispensedTodayElsewhere(d, a.patientId, kitItems, { alsoKit: true, now });
        if (givenToday.size && !a.force)
            throw new HttpError(409, `Already dispensed today from this patient's earlier kit orders: ${[...givenToday.values()].join(", ")}. `
                + "Apply the kit anyway? Those items will need a confirmation before they are dispensed again today.", { code: "needs_force", items: [...givenToday.keys()] });
        let deleted = 0, stopped = 0;
        if (a.replaceAuto) {
            const auto = "patient_id = ? AND order_type = 'operation' AND is_auto_from_operation = 1";
            const dispensed = "(EXISTS (SELECT 1 FROM dispenses x WHERE x.order_id = medication_orders.id) OR EXISTS (SELECT 1 FROM dispensed_slots s WHERE s.order_id = medication_orders.id))";
            stopped = d.run(`UPDATE medication_orders SET status = 'stopped', updated_at = ? WHERE ${auto} AND status <> 'stopped' AND ${dispensed}`, [stamp, a.patientId]).changes;
            deleted = d.run(`DELETE FROM medication_orders WHERE ${auto} AND NOT ${dispensed}`, [a.patientId]).changes;
        }
        const today = medicalDay(now, scheduleSettings(d).dayStart).label;
        let order = (d.get("SELECT MAX(display_order) m FROM medication_orders WHERE patient_id = ?", [a.patientId])?.m ?? 0) + 1;
        let inserted = 0;
        const excluded = [];
        for (const l of lines) {
            if (l.excluded) {
                excluded.push({ itemId: l.item_id, itemName: l.item_name });
                continue;
            }
            const id = d.run(`INSERT INTO medication_orders(patient_id, item_id, qty_per_dose, total_daily_qty, order_type, start_date, first_dose_time, duration_days,
           frequency_hours, status, notes, display_order, is_auto_from_operation, source_operation_id, source_kit_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,'operation',?,?,1,NULL,'active',?,?,1,?,?,?,?,?)`, [a.patientId, l.item_id, l.default_qty, l.default_qty, toLocalDate(now), toHHMM(now), KIT_NOTE, order++, a.operationId, kit.id, a.userId, stamp, stamp]).lastId;
            if (givenToday.has(l.item_id))
                markEditedAfterDispense(d, id, today);
            inserted++;
        }
        d.run("UPDATE patients SET operation_id = ?, updated_at = ? WHERE id = ?", [a.operationId, stamp, a.patientId]);
        return { inserted, excluded, deleted, stopped, kitId: kit.id };
    });
}
// a kit line becomes the qty per dose of an operation order: same 0.001 floor as orders (quantities have 3 decimals)
const zKitQty = z.coerce.number().positive("Quantity must be greater than zero").min(0.001, "Quantity must be at least 0.001").max(100000);
const zOp = z.object({
    opNo: zText(40),
    name: z.string().trim().min(1, "Enter the operation name").max(300),
    locationId: z.coerce.number().int().positive().nullable().optional(),
    active: zBool.optional(),
});
export default async function routes(app) {
    const loc = (req) => req.ctx.locationId;
    /**
     * Operations of this pharmacy + global ones, by operation number.
     * Default: active only ([{id, opNo, name, locationId, active}]). ?all=1 adds inactive ones and kit info for the manage screen.
     */
    app.get("/", async (req) => {
        const q = parse(z.object({ all: z.coerce.number().optional() }), req.query);
        const d = db();
        if (!q.all)
            return d.all(`${OP_SELECT} WHERE o.active = 1 AND ${VISIBLE} ${OP_ORDER}`, { loc: loc(req) })
                .map((o) => ({ ...o, active: !!o.active }));
        return d.all(`SELECT o.id, o.op_no AS opNo, o.name, o.location_id AS locationId, o.active, k.id AS kitId, k.active AS kitActive,
              (SELECT COUNT(*) FROM operation_kit_lines l WHERE l.kit_id = k.id) AS kitLineCount
       FROM operations o LEFT JOIN operation_kits k ON k.operation_id = o.id AND k.location_id = :loc
       WHERE ${VISIBLE} ${OP_ORDER}`, { loc: loc(req) }).map((o) => ({ ...o, active: !!o.active, kitActive: o.kitId ? !!o.kitActive : null }));
    });
    app.post("/", async (req) => {
        requireWrite(req);
        const b = parse(zOp, req.body);
        const locationId = b.locationId === undefined ? loc(req) : b.locationId;
        canEditOperation(req.ctx, locationId);
        const d = db();
        const id = d.run("INSERT INTO operations(op_no, name, location_id, active) VALUES (?,?,?,?)", [b.opNo ?? null, b.name, locationId, b.active ?? 1]).lastId;
        audit(req, "operation.create", "operation", id, b);
        // not loadOperation: an admin may create an operation for another pharmacy, which is not "visible" here
        const row = d.get(`${OP_SELECT} WHERE o.id = ?`, [id]);
        return { ...row, active: !!row.active };
    });
    // ----- exclusions (static paths before /:id) -----
    app.get("/exclusions", async (req) => exclusions(db(), loc(req)));
    app.post("/exclusions", async (req) => {
        requireWrite(req);
        const b = parse(z.object({ itemId: zItemId, reason: zText(500), active: zBool.optional() }), req.body);
        const d = db();
        itemExists(d, b.itemId);
        if (d.get("SELECT 1 FROM operation_kit_exclusions WHERE location_id = ? AND item_id = ?", [loc(req), b.itemId]))
            throw new HttpError(409, "This item is already excluded in this pharmacy");
        const id = d.run("INSERT INTO operation_kit_exclusions(location_id, item_id, active, reason) VALUES (?,?,?,?)", [loc(req), b.itemId, b.active ?? 1, b.reason ?? null]).lastId;
        audit(req, "operation.exclusion_add", "operation_kit_exclusion", id, b);
        return exclusions(d, loc(req));
    });
    app.patch("/exclusions/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ reason: zText(500).optional(), active: zBool.optional() }), req.body);
        const d = db();
        const e = d.get("SELECT * FROM operation_kit_exclusions WHERE id = ?", [id]);
        if (!e || e.location_id !== loc(req))
            throw notFound("Exclusion");
        d.run("UPDATE operation_kit_exclusions SET reason = ?, active = ? WHERE id = ?", [b.reason !== undefined ? b.reason : e.reason, b.active ?? e.active, id]);
        audit(req, "operation.exclusion_update", "operation_kit_exclusion", id, b);
        return exclusions(d, loc(req));
    });
    app.delete("/exclusions/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const r = d.run("DELETE FROM operation_kit_exclusions WHERE id = ? AND location_id = ?", [id, loc(req)]);
        if (!r.changes)
            throw notFound("Exclusion");
        audit(req, "operation.exclusion_delete", "operation_kit_exclusion", id);
        return exclusions(d, loc(req));
    });
    /**
     * Apply the operation's kit to a patient → {inserted, excluded:[{itemId,itemName}], deleted, stopped}.
     * 409 needs_force when items of the kit were already dispensed today from earlier kit orders (pass force to apply anyway).
     */
    app.post("/apply-kit", async (req) => {
        requireWrite(req);
        const b = parse(z.object({ patientId: z.string().trim().min(1, "Choose the patient").max(100), operationId: zId, replaceAuto: z.boolean().optional(), force: z.boolean().optional() }), req.body);
        const r = applyKit(db(), { patientId: b.patientId, operationId: b.operationId, replaceAuto: b.replaceAuto ?? true, locationId: loc(req), userId: req.ctx.userId, force: b.force });
        audit(req, "operation.apply_kit", "patient", b.patientId, { operationId: b.operationId, ...r });
        return r;
    });
    // ----- kits -----
    app.patch("/kits/:kitId", async (req) => {
        requireWrite(req);
        const { kitId } = parse(z.object({ kitId: zId }), req.params);
        const b = parse(z.object({ active: zBool.optional(), notes: zText(1000).optional() }), req.body);
        const d = db();
        const k = loadKit(d, kitId, loc(req));
        const cur = d.get("SELECT active, notes FROM operation_kits WHERE id = ?", [kitId]);
        d.run("UPDATE operation_kits SET active = ?, notes = ? WHERE id = ?", [b.active ?? cur.active, b.notes !== undefined ? b.notes : cur.notes, kitId]);
        audit(req, "operation.kit_update", "operation_kit", kitId, b);
        return kitOf(d, k.operation_id, loc(req));
    });
    app.post("/kits/:kitId/lines", async (req) => {
        requireWrite(req);
        const { kitId } = parse(z.object({ kitId: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId, defaultQty: zKitQty.optional(), active: zBool.optional() }), req.body);
        const d = db();
        const k = loadKit(d, kitId, loc(req));
        itemExists(d, b.itemId);
        const id = d.run("INSERT INTO operation_kit_lines(kit_id, item_id, default_qty, active) VALUES (?,?,?,?)", [kitId, b.itemId, b.defaultQty ?? 1, b.active ?? 1]).lastId;
        audit(req, "operation.kit_line_add", "operation_kit_line", id, { kitId, ...b });
        return kitOf(d, k.operation_id, loc(req));
    });
    app.patch("/kits/:kitId/lines/:lineId", async (req) => {
        requireWrite(req);
        const { kitId, lineId } = parse(z.object({ kitId: zId, lineId: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId.optional(), defaultQty: zKitQty.optional(), active: zBool.optional() }), req.body);
        const d = db();
        const k = loadKit(d, kitId, loc(req));
        const l = d.get("SELECT * FROM operation_kit_lines WHERE id = ? AND kit_id = ?", [lineId, kitId]);
        if (!l)
            throw notFound("Line");
        if (b.itemId)
            itemExists(d, b.itemId);
        d.run("UPDATE operation_kit_lines SET item_id = ?, default_qty = ?, active = ? WHERE id = ?", [b.itemId ?? l.item_id, b.defaultQty ?? l.default_qty, b.active ?? l.active, lineId]);
        audit(req, "operation.kit_line_update", "operation_kit_line", lineId, b);
        return kitOf(d, k.operation_id, loc(req));
    });
    app.delete("/kits/:kitId/lines/:lineId", async (req) => {
        requireWrite(req);
        const { kitId, lineId } = parse(z.object({ kitId: zId, lineId: zId }), req.params);
        const d = db();
        const k = loadKit(d, kitId, loc(req));
        const r = d.run("DELETE FROM operation_kit_lines WHERE id = ? AND kit_id = ?", [lineId, kitId]);
        if (!r.changes)
            throw notFound("Line");
        audit(req, "operation.kit_line_delete", "operation_kit_line", lineId, { kitId });
        return kitOf(d, k.operation_id, loc(req));
    });
    // ----- one operation -----
    app.get("/:id", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        return loadOperation(db(), id, loc(req));
    });
    app.patch("/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(zOp.partial(), req.body);
        const d = db();
        const o = loadOperation(d, id, loc(req));
        canEditOperation(req.ctx, o.locationId);
        const locationId = b.locationId === undefined ? o.locationId : b.locationId;
        canEditOperation(req.ctx, locationId);
        d.run("UPDATE operations SET op_no = ?, name = ?, location_id = ?, active = ? WHERE id = ?", [b.opNo !== undefined ? b.opNo : o.opNo, b.name ?? o.name, locationId, b.active ?? (o.active ? 1 : 0), id]);
        audit(req, "operation.update", "operation", id, b);
        const row = d.get(`${OP_SELECT} WHERE o.id = ?`, [id]);
        return { ...row, active: !!row.active };
    });
    /** Delete an operation that nothing refers to; otherwise deactivate it instead. */
    app.delete("/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const o = loadOperation(d, id, loc(req));
        canEditOperation(req.ctx, o.locationId);
        if (d.get("SELECT 1 FROM patients WHERE operation_id = ? LIMIT 1", [id]) || d.get("SELECT 1 FROM medication_orders WHERE source_operation_id = ? LIMIT 1", [id]))
            throw new HttpError(409, "The operation is linked to patients or orders — deactivate it instead of deleting it");
        // Deleting takes every pharmacy's kit with it; a pharmacist sees and manages only their own pharmacy's kit.
        if (req.ctx.role !== "admin" && d.get("SELECT 1 FROM operation_kits WHERE operation_id = ? AND location_id <> ? LIMIT 1", [id, loc(req)]))
            throw new HttpError(409, "Another pharmacy has a kit for this operation — deactivate it instead of deleting it");
        d.tx(() => {
            for (const k of d.all("SELECT id FROM operation_kits WHERE operation_id = ?", [id])) {
                d.run("DELETE FROM operation_kit_lines WHERE kit_id = ?", [k.id]);
            }
            d.run("DELETE FROM operation_kits WHERE operation_id = ?", [id]);
            d.run("DELETE FROM operations WHERE id = ?", [id]);
        });
        audit(req, "operation.delete", "operation", id, { name: o.name });
        return { ok: true };
    });
    /** This pharmacy's kit for the operation (null when none yet). */
    app.get("/:id/kit", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        loadOperation(d, id, loc(req));
        return kitOf(d, id, loc(req));
    });
    /** Create the kit if missing (legacy cmdLoadKit_Click) and return it. */
    app.post("/:id/kit", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        loadOperation(d, id, loc(req));
        if (!kitOf(d, id, loc(req))) {
            const kid = d.run("INSERT OR IGNORE INTO operation_kits(operation_id, location_id, active) VALUES (?,?,1)", [id, loc(req)]).lastId;
            audit(req, "operation.kit_create", "operation_kit", kid, { operationId: id });
        }
        return kitOf(d, id, loc(req));
    });
}
