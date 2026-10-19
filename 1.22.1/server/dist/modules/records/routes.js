import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, can, HttpError, notFound, parse, requirePerm, zDate, zId } from "../../lib/http.js";
import { addDays, nowIso, now as clockNow, parseLocal, toLocalDate } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { accessOf } from "../../auth/access.js";
import { checkUserPassword } from "../../auth/passwords.js";
import { throttledCheck } from "../../lib/rate-limit.js";
import { available, dispenseFEFO } from "../../core/fefo.js";
import { patientInLocation } from "../patients/scope.js";
export const INTERVENTION_KINDS = ["dose", "interaction", "allergy", "duplicate", "renal", "route", "iv_compatibility", "indication", "monitoring", "other"];
const zText = (max = 500) => z.string().trim().max(max).nullish().transform((v) => v || null);
const zRange = z.object({ from: zDate.optional(), to: zDate.optional() });
const range = (q) => {
    const to = q.to ?? toLocalDate(clockNow());
    return { from: q.from ?? toLocalDate(addDays(parseLocal(to), -29)), to };
};
/**
 * A second person's username and password (a witness): another active user who can dispense or keep the records and
 * can work in this pharmacy (it is theirs, or they work in any). Returns their id. Work replayed from a pharmacy PC was
 * signed there: its queued copy keeps the username only (core/safety.ts scrubSafetyBody), the rest is checked again.
 */
function witness(req, w) {
    const replay = req.ctx.token === "replay";
    if (!w?.username || (!w.password && !replay))
        throw new HttpError(400, "A witness signs the count: enter their username and password");
    const u = db().get("SELECT id, password_hash, role, role_id, active, location_id FROM users WHERE username = ? COLLATE NOCASE", [w.username]);
    if (!replay) {
        const ok = throttledCheck("login", req.ip, w.username, () => checkUserPassword(w.password, u?.active ? u.password_hash : null));
        if (!ok)
            throw new HttpError(400, "The witness's username or password is wrong");
    }
    if (!u || !u.active)
        throw new HttpError(400, "The witness's username or password is wrong");
    if (u.id === req.ctx.userId)
        throw new HttpError(400, "The witness must be another person");
    const perms = accessOf(u).perms;
    if (!perms.has("dispense") && !perms.has("records"))
        throw new HttpError(400, "The witness's role does not include dispensing or the records");
    if (u.location_id != null && u.location_id !== req.ctx.locationId && !perms.has("pharmacies.all"))
        throw new HttpError(400, "The witness works in another pharmacy");
    return u.id;
}
const zWitness = z.object({ username: z.string().trim().max(100), password: z.string().max(200).nullish() }).nullish();
/** All real stock of an item at a pharmacy (expired and held too: the register counts what is in the cupboard). */
const onHand = (itemId, loc) => round3(db().get("SELECT COALESCE(SUM(qty),0) q FROM batches WHERE item_id = ? AND location_id = ? AND is_placeholder = 0", [itemId, loc]).q);
export default async function routes(app) {
    // ======== controlled medicines
    app.get("/controlled/items", async (req) => {
        const loc = req.ctx.locationId;
        return db().all(`SELECT i.id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, i.controlled, i.custody_page AS "custodyPage",
         (SELECT COALESCE(SUM(qty),0) FROM batches b WHERE b.item_id = i.id AND b.location_id = ? AND b.is_placeholder = 0) AS "onHand",
         (SELECT MAX(at) FROM cd_checks c WHERE c.item_id = i.id AND c.location_id = ?) AS "lastCheck",
         (SELECT counted - expected FROM cd_checks c WHERE c.item_id = i.id AND c.location_id = ? ORDER BY at DESC, id DESC LIMIT 1) AS "lastDifference"
       FROM items i WHERE i.controlled IS NOT NULL AND i.active = 1 ORDER BY "onHand" <= 0, i.controlled, i.name COLLATE NOCASE`, [loc, loc, loc])
            .map((r) => ({ ...r, onHand: round3(r.onHand) }));
    });
    /** Mark an item controlled (narcotic / psychotropic) or not. */
    app.patch("/controlled/items/:itemId", async (req) => {
        // the flag is the catalogue's (every pharmacy's register and the accreditation pack follow it)
        requirePerm(req, "records.setup");
        requirePerm(req, "items");
        const itemId = String(req.params.itemId);
        const b = parse(z.object({ controlled: z.enum(["narcotic", "psychotropic"]).nullable() }), req.body);
        if (!db().get("SELECT 1 FROM items WHERE id = ?", [itemId]))
            throw notFound("Item");
        db().run("UPDATE items SET controlled = ? WHERE id = ?", [b.controlled, itemId]);
        audit(req, "records.controlled_flag", "item", itemId, b);
        return { ok: true };
    });
    /**
     * The register of one controlled medicine at this pharmacy for a period: the balance brought forward, every movement
     * (received, dispensed to a patient, returned, transferred, adjusted) with the balance after it, and the counts.
     */
    app.get("/controlled/register", async (req) => {
        if (!can(req.ctx, "reports") && !can(req.ctx, "records"))
            requirePerm(req, "reports");
        const q = parse(zRange.extend({ itemId: z.string().trim().min(1) }), req.query);
        const { from, to } = range(q);
        const loc = req.ctx.locationId;
        const item = db().get(`SELECT id, name, selection_name AS "selectionName", unit, controlled, custody_page AS "custodyPage" FROM items WHERE id = ?`, [q.itemId]);
        if (!item)
            throw notFound("Item");
        const opening = round3(db().get(`SELECT COALESCE(SUM(m.qty_delta),0) q FROM stock_movements m JOIN batches b ON b.id = m.batch_id
       WHERE b.item_id = ? AND b.location_id = ? AND b.is_placeholder = 0 AND m.at < ?`, [q.itemId, loc, from]).q);
        const rows = db().all(`SELECT m.id, m.at, m.kind, m.qty_delta AS "qtyDelta", m.note, m.ref, b.batch_no AS "batchNo", b.expiry_date AS expiry, u.display_name AS "user",
         x.patient_id AS "patientId", COALESCE(p.name, x.patient_name) AS "patientName", dep.name AS department, x.type AS "dispenseType"
       FROM stock_movements m JOIN batches b ON b.id = m.batch_id LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN dispenses x ON x.id = m.dispense_id LEFT JOIN patients p ON p.id = x.patient_id LEFT JOIN departments dep ON dep.id = p.department_id
       WHERE b.item_id = ? AND b.location_id = ? AND b.is_placeholder = 0 AND m.at >= ? AND m.at < date(?, '+1 day')
       ORDER BY m.at, m.id`, [q.itemId, loc, from, to]);
        let bal = opening;
        const lines = rows.map((r) => { bal = round3(bal + r.qtyDelta); return { ...r, balance: bal }; });
        const checks = db().all(`SELECT c.at, c.expected, c.counted, c.note, u.display_name AS "user", w.display_name AS witness FROM cd_checks c
       LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users w ON w.id = c.witness_id
       WHERE c.item_id = ? AND c.location_id = ? AND c.at >= ? AND c.at < date(?, '+1 day') ORDER BY c.at`, [q.itemId, loc, from, to]);
        return { item, from, to, opening, closing: bal, onHand: onHand(q.itemId, loc), lines, checks };
    });
    /** A witnessed count of a controlled medicine: the cupboard against the register. */
    app.post("/controlled/checks", async (req) => {
        requirePerm(req, "records");
        const b = parse(z.object({ itemId: z.string().trim().min(1), counted: z.coerce.number().finite().min(0).max(1_000_000), note: zText(), witness: zWitness,
            /** The register's figure shown when counting (a pharmacy PC's own, kept when its count is replayed here). */
            expected: z.coerce.number().finite().min(0).max(100_000_000).nullish() }), req.body);
        const it = db().get("SELECT controlled FROM items WHERE id = ?", [b.itemId]);
        if (!it)
            throw notFound("Item");
        if (!it.controlled)
            throw bad("This item is not marked as controlled");
        const w = witness(req, b.witness);
        // replayed from a pharmacy PC: the figures that were signed there (this server's stock may differ until it catches up)
        const replay = req.ctx.token === "replay";
        const expected = replay && b.expected != null ? round3(b.expected) : onHand(b.itemId, req.ctx.locationId);
        if (!replay && Math.abs(expected - b.counted) > 0.0005 && !b.note)
            throw new HttpError(400, `The count differs from the register (${expected}) — say why in the note`);
        const id = db().run("INSERT INTO cd_checks(item_id, location_id, at, expected, counted, note, user_id, witness_id) VALUES (?,?,?,?,?,?,?,?)", [b.itemId, req.ctx.locationId, nowIso(), expected, b.counted, b.note, req.ctx.userId, w]).lastId;
        audit(req, "records.cd_check", "item", b.itemId, { checkId: id, expected, counted: b.counted, witness: w });
        return { id, expected, counted: b.counted, difference: round3(b.counted - expected) };
    });
    // ======== fridges
    app.get("/fridges", async (req) => {
        const today = toLocalDate(clockNow());
        return db().all(`SELECT f.id, f.name, f.min_c AS "minC", f.max_c AS "maxC", f.readings_per_day AS "readingsPerDay", f.active,
         (SELECT temp_c FROM fridge_readings r WHERE r.fridge_id = f.id ORDER BY at DESC, id DESC LIMIT 1) AS "lastTemp",
         (SELECT at FROM fridge_readings r WHERE r.fridge_id = f.id ORDER BY at DESC, id DESC LIMIT 1) AS "lastAt",
         (SELECT COUNT(*) FROM fridge_readings r WHERE r.fridge_id = f.id AND r.at >= ?) AS "today",
         (SELECT COUNT(*) FROM fridge_readings r WHERE r.fridge_id = f.id AND r.out_of_range = 1 AND r.at >= date(?, '-6 days')) AS "outOfRangeWeek"
       FROM fridges f WHERE f.location_id = ? ORDER BY f.active DESC, f.name`, [today, today, req.ctx.locationId]).map((f) => ({ ...f, active: !!f.active }));
    });
    const zFridge = z.object({ name: z.string().trim().min(2).max(80), minC: z.coerce.number().finite().min(-40).max(30), maxC: z.coerce.number().finite().min(-40).max(40),
        readingsPerDay: z.coerce.number().int().min(1).max(24).default(2), active: z.boolean().optional() }).refine((f) => f.maxC > f.minC, "The highest temperature must be above the lowest");
    app.post("/fridges", async (req) => {
        requirePerm(req, "records.setup");
        const b = parse(zFridge, req.body);
        const id = db().run("INSERT INTO fridges(location_id, name, min_c, max_c, readings_per_day, active, created_at) VALUES (?,?,?,?,?,1,?)", [req.ctx.locationId, b.name, b.minC, b.maxC, b.readingsPerDay, nowIso()]).lastId;
        audit(req, "records.fridge_create", "fridge", id, b);
        return { id };
    });
    const ownFridge = (req, id) => {
        const f = db().get("SELECT id, location_id, min_c, max_c, active FROM fridges WHERE id = ?", [id]);
        if (!f || f.location_id !== req.ctx.locationId)
            throw notFound("Fridge");
        return f;
    };
    app.put("/fridges/:id", async (req) => {
        requirePerm(req, "records.setup");
        const id = parse(zId, req.params.id);
        ownFridge(req, id);
        const b = parse(zFridge, req.body);
        db().run("UPDATE fridges SET name=?, min_c=?, max_c=?, readings_per_day=?, active=? WHERE id=?", [b.name, b.minC, b.maxC, b.readingsPerDay, b.active === false ? 0 : 1, id]);
        audit(req, "records.fridge_update", "fridge", id, b);
        return { ok: true };
    });
    app.post("/fridges/:id/readings", async (req) => {
        requirePerm(req, "records");
        const id = parse(zId, req.params.id);
        const f = ownFridge(req, id);
        if (!f.active)
            throw bad("This fridge is not in use");
        // a blank or unreadable value is not 0 °C
        const t = z.number({ error: "Temperature must be a number" }).finite().min(-50).max(60);
        const num = (v) => (v === "" || v == null ? v ?? undefined : typeof v === "string" ? Number(v.replace(",", ".")) : v);
        const b = parse(z.object({ tempC: z.preprocess((v) => (v === "" || v == null ? undefined : num(v)), t),
            minC: z.preprocess((v) => (v === "" || v == null ? null : num(v)), t.nullable()), maxC: z.preprocess((v) => (v === "" || v == null ? null : num(v)), t.nullable()),
            action: zText() }), req.body);
        const out = [b.tempC, b.minC, b.maxC].some((v) => v != null && (v < f.min_c || v > f.max_c));
        if (out && !b.action)
            throw new HttpError(400, `Out of range (${f.min_c}–${f.max_c} °C): say what was done (for example: door closed, medicines moved, engineer called)`, { code: "out_of_range" });
        const rid = db().run("INSERT INTO fridge_readings(fridge_id, at, temp_c, min_c, max_c, out_of_range, action, user_id) VALUES (?,?,?,?,?,?,?,?)", [id, nowIso(), b.tempC, b.minC ?? null, b.maxC ?? null, out ? 1 : 0, b.action, req.ctx.userId]).lastId;
        audit(req, "records.fridge_reading", "fridge", id, { readingId: rid, tempC: b.tempC, outOfRange: out });
        return { id: rid, outOfRange: out };
    });
    app.get("/fridges/:id/readings", async (req) => {
        const id = parse(zId, req.params.id);
        ownFridge(req, id);
        const { from, to } = range(parse(zRange, req.query));
        return db().all(`SELECT r.id, r.at, r.temp_c AS "tempC", r.min_c AS "minC", r.max_c AS "maxC", r.out_of_range AS "outOfRange", r.action, u.display_name AS "user"
       FROM fridge_readings r LEFT JOIN users u ON u.id = r.user_id WHERE r.fridge_id = ? AND r.at >= ? AND r.at < date(?, '+1 day') ORDER BY r.at`, [id, from, to])
            .map((r) => ({ ...r, outOfRange: !!r.outOfRange }));
    });
    // ======== emergency carts and ward stock
    const cartRow = (id, loc) => {
        const c = db().get(`SELECT c.id, c.name, c.kind, c.department_id AS "departmentId", d.name AS department, c.check_every_days AS "checkEveryDays", c.active, c.location_id AS "locationId"
       FROM carts c LEFT JOIN departments d ON d.id = c.department_id WHERE c.id = ?`, [id]);
        if (!c || c.locationId !== loc)
            throw notFound("Cart");
        return c;
    };
    app.get("/carts", async (req) => {
        const today = toLocalDate(clockNow());
        return db().all(`SELECT c.id, c.name, c.kind, d.name AS department, c.check_every_days AS "checkEveryDays", c.active,
         (SELECT COUNT(*) FROM cart_items ci WHERE ci.cart_id = c.id) AS "itemCount",
         (SELECT MAX(at) FROM cart_checks k WHERE k.cart_id = c.id) AS "lastCheck",
         (SELECT status FROM cart_checks k WHERE k.cart_id = c.id ORDER BY at DESC, id DESC LIMIT 1) AS "lastStatus",
         (SELECT MIN(cl.nearest_expiry) FROM cart_check_lines cl WHERE cl.check_id = (SELECT id FROM cart_checks k WHERE k.cart_id = c.id ORDER BY at DESC, id DESC LIMIT 1)
            AND cl.nearest_expiry IS NOT NULL) AS "nearestExpiry"
       FROM carts c LEFT JOIN departments d ON d.id = c.department_id WHERE c.location_id = ? ORDER BY c.active DESC, c.name`, [req.ctx.locationId])
            .map((c) => ({ ...c, active: !!c.active, due: !c.lastCheck || toLocalDate(addDays(parseLocal(c.lastCheck.slice(0, 10)), c.checkEveryDays)) <= today }));
    });
    app.get("/carts/:id", async (req) => {
        const c = cartRow(parse(zId, req.params.id), req.ctx.locationId);
        const last = db().get("SELECT id FROM cart_checks WHERE cart_id = ? ORDER BY at DESC, id DESC LIMIT 1", [c.id]);
        const items = db().all(`SELECT ci.item_id AS "itemId", i.name AS "itemName", i.selection_name AS "selectionName", i.unit, ci.par_qty AS "parQty",
         cl.present AS "lastPresent", cl.nearest_expiry AS "lastExpiry"
       FROM cart_items ci JOIN items i ON i.id = ci.item_id LEFT JOIN cart_check_lines cl ON cl.check_id = ? AND cl.item_id = ci.item_id
       WHERE ci.cart_id = ? ORDER BY i.name COLLATE NOCASE`, [last?.id ?? 0, c.id]).map((r) => ({ ...r, availableHere: available(db(), r.itemId, req.ctx.locationId, { includePlaceholders: false }) }));
        const checks = db().all(`SELECT k.id, k.at, k.seal_no AS "sealNo", k.status, k.note, u.display_name AS "user" FROM cart_checks k LEFT JOIN users u ON u.id = k.user_id
       WHERE k.cart_id = ? ORDER BY k.at DESC, k.id DESC LIMIT 50`, [c.id]);
        return { ...c, active: !!c.active, items, checks };
    });
    const zCart = z.object({
        name: z.string().trim().min(2).max(80), kind: z.enum(["emergency", "ward_stock"]).default("emergency"),
        departmentId: z.coerce.number().int().positive().nullish(), checkEveryDays: z.coerce.number().int().min(1).max(365).default(30), active: z.boolean().optional(),
        items: z.array(z.object({ itemId: z.string().trim().min(1), parQty: z.coerce.number().finite().positive().max(100000) })).max(300),
    });
    const saveCart = (req, id) => {
        const b = parse(zCart, req.body);
        const d = db();
        if (b.departmentId && !d.get("SELECT 1 FROM departments WHERE id = ? AND location_id = ?", [b.departmentId, req.ctx.locationId]))
            throw bad("Choose a department of this pharmacy");
        if (new Set(b.items.map((i) => i.itemId)).size !== b.items.length)
            throw bad("An item is listed twice");
        return d.tx(() => {
            let cid = id;
            if (cid == null)
                cid = d.run("INSERT INTO carts(location_id, department_id, name, kind, check_every_days, active, created_at) VALUES (?,?,?,?,?,1,?)", [req.ctx.locationId, b.departmentId ?? null, b.name, b.kind, b.checkEveryDays, nowIso()]).lastId;
            else
                d.run("UPDATE carts SET department_id=?, name=?, kind=?, check_every_days=?, active=? WHERE id=?", [b.departmentId ?? null, b.name, b.kind, b.checkEveryDays, b.active === false ? 0 : 1, cid]);
            d.run("DELETE FROM cart_items WHERE cart_id = ?", [cid]);
            for (const i of b.items) {
                if (!d.get("SELECT 1 FROM items WHERE id = ?", [i.itemId]))
                    throw bad(`Item ${i.itemId} not found`);
                d.run("INSERT INTO cart_items(cart_id, item_id, par_qty) VALUES (?,?,?)", [cid, i.itemId, i.parQty]);
            }
            audit(req, id == null ? "records.cart_create" : "records.cart_update", "cart", cid, { name: b.name, items: b.items.length });
            return { id: cid };
        });
    };
    app.post("/carts", async (req) => { requirePerm(req, "records.setup"); return saveCart(req, null); });
    app.put("/carts/:id", async (req) => {
        requirePerm(req, "records.setup");
        const id = parse(zId, req.params.id);
        cartRow(id, req.ctx.locationId);
        return saveCart(req, id);
    });
    /**
     * A check of a cart: the seal number, what is in it and the nearest expiry of each item. With restock, what is missing
     * (up to the par level) is dispensed from this pharmacy's stock to the cart (earliest expiry first, type "cart").
     */
    app.post("/carts/:id/checks", async (req) => {
        requirePerm(req, "records");
        const id = parse(zId, req.params.id);
        const c = cartRow(id, req.ctx.locationId);
        const b = parse(z.object({ sealNo: zText(40), note: zText(), restock: z.boolean().optional(),
            lines: z.array(z.object({ itemId: z.string().trim().min(1), present: z.coerce.number().finite().min(0).max(100000),
                expired: z.coerce.number().finite().min(0).max(100000).default(0), nearestExpiry: zDate.nullish() })).max(300) }), req.body);
        if (b.restock)
            requirePerm(req, "dispense");
        const d = db();
        const par = new Map(d.all("SELECT item_id, par_qty FROM cart_items WHERE cart_id = ?", [id]).map((r) => [r.item_id, r.par_qty]));
        for (const l of b.lines)
            if (!par.has(l.itemId))
                throw bad(`Item ${l.itemId} is not in this cart`);
        // a check covers the whole cart, each item once
        if (new Set(b.lines.map((l) => l.itemId)).size !== b.lines.length)
            throw bad("An item is listed twice");
        if (b.lines.length !== par.size)
            throw bad("Check every item of the cart");
        const today = toLocalDate(clockNow());
        for (const l of b.lines) {
            if (l.expired > l.present + 0.0005)
                throw bad("More expired than present");
            if (l.nearestExpiry && l.nearestExpiry < today && !l.expired)
                throw bad("A pack has expired: say how many are expired (they are replaced)");
        }
        return d.tx(() => {
            const checkId = d.run("INSERT INTO cart_checks(cart_id, at, seal_no, status, note, user_id) VALUES (?,?,?,?,?,?)", [id, nowIso(), b.sealNo, "ok", b.note, req.ctx.userId]).lastId;
            let short = 0, restocked = 0;
            for (const l of b.lines) {
                // what is short of the par, counting expired packs (taken out) as missing
                const missing = round3(Math.max(0, par.get(l.itemId) - (l.present - l.expired)));
                let put = 0;
                if (missing > 0 && b.restock) {
                    const r = dispenseFEFO(d, { locationId: req.ctx.locationId, itemId: l.itemId, qty: missing, type: "cart", userId: req.ctx.userId,
                        includePlaceholders: false, notes: `Cart: ${c.name}`, patientName: c.department ?? c.name });
                    put = r.dispensed;
                    restocked += put;
                }
                if (missing - put > 0.0005)
                    short++;
                d.run("INSERT INTO cart_check_lines(check_id, item_id, present, expired, nearest_expiry, restocked) VALUES (?,?,?,?,?,?)", [checkId, l.itemId, l.present, l.expired, l.nearestExpiry ?? null, put]);
            }
            const status = short ? "needs_restock" : restocked > 0 ? "restocked" : "ok";
            d.run("UPDATE cart_checks SET status = ? WHERE id = ?", [status, checkId]);
            audit(req, "records.cart_check", "cart", id, { checkId, status, restocked });
            return { id: checkId, status, restocked: round3(restocked) };
        });
    });
    // ======== interventions
    app.get("/interventions", async (req) => {
        const q = parse(zRange.extend({ patientId: z.string().trim().max(100).optional() }), req.query);
        const { from, to } = range(q);
        const where = ["v.location_id = ?", "v.at >= ?", "v.at < date(?, '+1 day')"];
        const params = [req.ctx.locationId, from, to];
        if (q.patientId) {
            where.push("v.patient_id = ?");
            params.push(q.patientId);
        }
        const rows = db().all(`SELECT v.id, v.at, v.patient_id AS "patientId", p.name AS "patientName", v.order_id AS "orderId", v.item_id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName",
         v.kind, v.problem, v.recommendation, v.prescriber, v.outcome, v.significance, u.display_name AS "user"
       FROM interventions v LEFT JOIN patients p ON p.id = v.patient_id LEFT JOIN items i ON i.id = v.item_id LEFT JOIN users u ON u.id = v.user_id
       WHERE ${where.join(" AND ")} ORDER BY v.at DESC LIMIT 1000`, params);
        // the figures over the whole period (the list stops at 1000)
        const agg = db().get(`SELECT COUNT(*) total, SUM(CASE WHEN v.outcome IN ('accepted','modified') THEN 1 ELSE 0 END) accepted, SUM(CASE WHEN v.outcome <> 'pending' THEN 1 ELSE 0 END) decided
       FROM interventions v WHERE ${where.join(" AND ")}`, params);
        return { from, to, rows, total: agg.total, accepted: agg.accepted ?? 0,
            acceptanceRate: agg.decided ? Math.round(((agg.accepted ?? 0) / agg.decided) * 100) : null };
    });
    const zIntervention = z.object({
        patientId: z.string().trim().max(100).nullish(), orderId: z.coerce.number().int().positive().nullish(), itemId: z.string().trim().max(40).nullish(),
        kind: z.enum(INTERVENTION_KINDS), problem: z.string().trim().min(3, "Describe the problem").max(1000), recommendation: zText(1000), prescriber: zText(120),
        outcome: z.enum(["pending", "accepted", "modified", "rejected"]).default("pending"), significance: z.enum(["minor", "moderate", "major"]).nullish(),
    });
    app.post("/interventions", async (req) => {
        requirePerm(req, "records");
        const b = parse(zIntervention, req.body);
        if (b.patientId)
            patientInLocation(db(), b.patientId, req.ctx.locationId);
        if (b.orderId && !db().get("SELECT 1 FROM medication_orders WHERE id = ? AND patient_id IS ?", [b.orderId, b.patientId ?? null]))
            throw bad("The order is not this patient's");
        if (b.itemId && !db().get("SELECT 1 FROM items WHERE id = ?", [b.itemId]))
            throw bad("Item not found");
        const id = db().run(`INSERT INTO interventions(at, location_id, patient_id, order_id, item_id, kind, problem, recommendation, prescriber, outcome, significance, user_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [nowIso(), req.ctx.locationId, b.patientId ?? null, b.orderId ?? null, b.itemId ?? null, b.kind, b.problem, b.recommendation,
            b.prescriber, b.outcome, b.significance ?? null, req.ctx.userId, nowIso()]).lastId;
        audit(req, "records.intervention", "intervention", id, { kind: b.kind, patientId: b.patientId, outcome: b.outcome });
        return { id };
    });
    app.patch("/interventions/:id", async (req) => {
        requirePerm(req, "records");
        const id = parse(zId, req.params.id);
        const v = db().get("SELECT location_id FROM interventions WHERE id = ?", [id]);
        if (!v || v.location_id !== req.ctx.locationId)
            throw notFound("Intervention");
        const b = parse(z.object({ outcome: z.enum(["pending", "accepted", "modified", "rejected"]), recommendation: zText(1000).optional(), prescriber: zText(120).optional() }), req.body);
        db().run(`UPDATE interventions SET outcome = ?, recommendation = COALESCE(?, recommendation), prescriber = COALESCE(?, prescriber), updated_at = ? WHERE id = ?`, [b.outcome, b.recommendation ?? null, b.prescriber ?? null, nowIso(), id]);
        audit(req, "records.intervention_outcome", "intervention", id, b);
        return { ok: true };
    });
    // ======== accreditation pack
    /** The period's records in one report for inspectors (this pharmacy, or ?all=1 every pharmacy). */
    app.get("/accreditation", async (req) => {
        requirePerm(req, "reports");
        const q = parse(zRange.extend({ all: z.coerce.number().optional() }), req.query);
        const { from, to } = range(q);
        const all = !!q.all && can(req.ctx, "pharmacies.all");
        const d = db();
        const loc = (col) => (all ? "1=1" : `${col} = ${Number(req.ctx.locationId)}`);
        const inRange = (col) => `${col} >= '${from}' AND ${col} < date('${to}', '+1 day')`;
        const days = Math.max(1, Math.round((parseLocal(to).getTime() - parseLocal(from).getTime()) / 86_400_000) + 1);
        const safety = d.all(`SELECT kind, action, COUNT(*) n FROM safety_alerts WHERE ${loc("location_id")} AND ${inRange("at")} GROUP BY kind, action ORDER BY kind`);
        const interventions = d.all(`SELECT kind, outcome, COUNT(*) n FROM interventions WHERE ${loc("location_id")} AND ${inRange("at")} GROUP BY kind, outcome ORDER BY kind`);
        const fridges = d.all(`SELECT f.id, f.name, l.name AS pharmacy, f.min_c AS "minC", f.max_c AS "maxC", f.readings_per_day AS "perDay", f.created_at AS "createdAt",
         (SELECT COUNT(*) FROM fridge_readings r WHERE r.fridge_id = f.id AND ${inRange("r.at")}) AS readings,
         (SELECT COUNT(*) FROM fridge_readings r WHERE r.fridge_id = f.id AND r.out_of_range = 1 AND ${inRange("r.at")}) AS "outOfRange",
         (SELECT MIN(temp_c) FROM fridge_readings r WHERE r.fridge_id = f.id AND ${inRange("r.at")}) AS "lowest",
         (SELECT MAX(temp_c) FROM fridge_readings r WHERE r.fridge_id = f.id AND ${inRange("r.at")}) AS "highest"
       FROM fridges f JOIN locations l ON l.id = f.location_id WHERE f.active = 1 AND ${loc("f.location_id")} ORDER BY l.name, f.name`)
            .map((f) => {
            // the readings due: from the period's start (or when the fridge was added) up to its end (or now), today in part
            const start = Math.max(parseLocal(from).getTime(), parseLocal(String(f.createdAt).slice(0, 19)).getTime());
            const end = Math.min(addDays(parseLocal(to), 1).getTime(), clockNow().getTime());
            const expected = Math.max(0, Math.floor(((end - start) / 86_400_000) * f.perDay));
            const { createdAt: _c, ...rest } = f;
            return { ...rest, expected, compliance: expected ? Math.min(100, Math.round((f.readings / expected) * 100)) : null };
        });
        const controlled = d.all(`SELECT i.id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName", i.controlled, COUNT(c.id) AS checks,
         SUM(CASE WHEN ABS(c.counted - c.expected) > 0.0005 THEN 1 ELSE 0 END) AS discrepancies
       FROM items i LEFT JOIN cd_checks c ON c.item_id = i.id AND ${loc("c.location_id")} AND ${inRange("c.at")}
       WHERE i.controlled IS NOT NULL AND i.active = 1 GROUP BY i.id ORDER BY i.controlled, i.name`);
        const carts = d.all(`SELECT c.name, l.name AS pharmacy, c.check_every_days AS "every", COUNT(k.id) AS checks, MAX(k.at) AS "lastCheck",
         SUM(CASE WHEN k.status = 'needs_restock' THEN 1 ELSE 0 END) AS "leftShort"
       FROM carts c JOIN locations l ON l.id = c.location_id LEFT JOIN cart_checks k ON k.cart_id = c.id AND ${inRange("k.at")}
       WHERE c.active = 1 AND ${loc("c.location_id")} GROUP BY c.id ORDER BY l.name, c.name`);
        const recalls = d.all(`SELECT h.kind, COALESCE(i.selection_name, i.name) AS "itemName", h.batch_no AS "batchNo", h.reason, h.created_at AS at FROM batch_holds h JOIN items i ON i.id = h.item_id
       WHERE ${inRange("h.created_at")} AND (h.location_id IS NULL OR ${loc("h.location_id")}) ORDER BY h.created_at`);
        const expiredNow = d.get(`SELECT COUNT(*) batches, COALESCE(SUM(qty),0) qty FROM batches WHERE ${loc("location_id")} AND is_placeholder = 0 AND qty > 0 AND expiry_date < '${toLocalDate(clockNow())}'`);
        const supplierReturns = d.get(`SELECT COUNT(*) n, COALESCE(SUM(qty),0) qty FROM supplier_returns WHERE ${loc("location_id")} AND ${inRange("at")}`);
        return { from, to, days, all, safety, interventions, fridges, controlled, carts, recalls, expiredNow, supplierReturns };
    });
}
