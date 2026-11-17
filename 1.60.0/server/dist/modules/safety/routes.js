import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, notFound, parse, requirePerm, zDate, zId } from "../../lib/http.js";
import { nowIso } from "../../lib/time.js";
import { safetyAlerts } from "../../core/safety.js";
import { patientInLocation } from "../patients/scope.js";
const zSide = z.object({ kind: z.enum(["ingredient", "class"], { message: "Choose ingredient or class" }), value: z.string().trim().min(2, "Enter the ingredient or class").max(120) });
const zRule = z.object({
    a: zSide, b: zSide,
    severity: z.enum(["minor", "moderate", "major", "contraindicated"], { message: "Choose the severity" }),
    message: z.string().trim().min(3, "Say what the interaction does").max(300),
    advice: z.string().trim().max(300).nullish().transform((v) => v || null),
    active: z.boolean().optional(),
});
const num = (what) => z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number({ message: `${what} must be a number` }).finite().positive(`${what} must be greater than zero`).max(1e7).nullable()).optional();
const zItemSafety = z.object({
    highAlert: z.boolean().optional(),
    tallManName: z.string().trim().max(200).nullish().transform((v) => (v === undefined ? undefined : v || null)),
    lasaGroup: z.string().trim().max(60).nullish().transform((v) => (v === undefined ? undefined : v || null)),
    doseUnit: z.string().trim().max(20).nullish().transform((v) => (v === undefined ? undefined : v || null)),
    maxSingleDose: num("Maximum dose"), maxDailyDose: num("Maximum daily dose"),
    maxSinglePerKg: num("Maximum dose per kg"), maxDailyPerKg: num("Maximum daily dose per kg"),
});
const RULE_SELECT = `SELECT r.id, r.a_kind AS "aKind", r.a_value AS "aValue", r.b_kind AS "bKind", r.b_value AS "bValue", r.severity, r.message, r.advice,
  r.active, r.updated_at AS "updatedAt", u.display_name AS "createdBy" FROM interaction_rules r LEFT JOIN users u ON u.id = r.created_by`;
const ruleView = (r) => ({ ...r, active: !!r.active });
const ITEM_SAFETY = `i.id, i.name, i.selection_name AS "selectionName", i.active_ingredient AS "activeIngredient", i.class, i.strength, i.strength_unit AS "strengthUnit",
  i.high_alert AS "highAlert", i.tall_man_name AS "tallManName", i.lasa_group AS "lasaGroup", i.dose_unit AS "doseUnit",
  i.max_single_dose AS "maxSingleDose", i.max_daily_dose AS "maxDailyDose", i.max_single_per_kg AS "maxSinglePerKg", i.max_daily_per_kg AS "maxDailyPerKg"`;
const itemView = (i) => ({ ...i, highAlert: !!i.highAlert });
export default async function routes(app) {
    // ---- interaction rules
    app.get("/rules", async () => db().all(`${RULE_SELECT} ORDER BY r.active DESC, r.a_value COLLATE NOCASE, r.b_value COLLATE NOCASE`).map(ruleView));
    app.post("/rules", async (req) => {
        requirePerm(req, "safety.rules");
        const b = parse(zRule, req.body);
        const r = db().run(`INSERT INTO interaction_rules(a_kind, a_value, b_kind, b_value, severity, message, advice, active, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [b.a.kind, b.a.value, b.b.kind, b.b.value, b.severity, b.message, b.advice, b.active === false ? 0 : 1, req.ctx.userId, nowIso(), nowIso()]);
        audit(req, "safety.rule.create", "interaction_rule", r.lastId, b);
        return ruleView(db().get(`${RULE_SELECT} WHERE r.id = ?`, [r.lastId]));
    });
    app.put("/rules/:id", async (req) => {
        requirePerm(req, "safety.rules");
        const id = parse(zId, req.params.id);
        const b = parse(zRule, req.body);
        if (!db().get("SELECT 1 FROM interaction_rules WHERE id = ?", [id]))
            throw notFound("Rule");
        db().run(`UPDATE interaction_rules SET a_kind=?, a_value=?, b_kind=?, b_value=?, severity=?, message=?, advice=?, active=?, updated_at=? WHERE id=?`, [b.a.kind, b.a.value, b.b.kind, b.b.value, b.severity, b.message, b.advice, b.active === false ? 0 : 1, nowIso(), id]);
        audit(req, "safety.rule.update", "interaction_rule", id, b);
        return ruleView(db().get(`${RULE_SELECT} WHERE r.id = ?`, [id]));
    });
    app.delete("/rules/:id", async (req) => {
        requirePerm(req, "safety.rules");
        const id = parse(zId, req.params.id);
        const r = db().get("SELECT * FROM interaction_rules WHERE id = ?", [id]);
        if (!r)
            throw notFound("Rule");
        db().run("DELETE FROM interaction_rules WHERE id = ?", [id]);
        audit(req, "safety.rule.delete", "interaction_rule", id, { a: r.a_value, b: r.b_value, severity: r.severity });
        return { ok: true };
    });
    /** Values to choose from when writing a rule: the catalogue's ingredients and classes. */
    app.get("/vocabulary", async () => {
        const ings = new Set();
        for (const r of db().all("SELECT DISTINCT active_ingredient ai FROM items WHERE active = 1 AND IFNULL(TRIM(active_ingredient),'') <> ''"))
            for (const p of r.ai.split(/\s*(?:\+|,|\/|&)\s*/))
                if (p.trim().length > 1)
                    ings.add(p.trim());
        const classes = db().all("SELECT DISTINCT TRIM(class) c FROM items WHERE active = 1 AND IFNULL(TRIM(class),'') NOT IN ('','-') ORDER BY c").map((r) => r.c);
        return { ingredients: [...ings].sort((a, b) => a.localeCompare(b)), classes };
    });
    // ---- item safety details
    /** Items with any safety detail (?all=1: every active item, ?q= search). */
    app.get("/items", async (req) => {
        const q = parse(z.object({ q: z.string().trim().max(100).optional(), all: z.coerce.number().optional() }), req.query);
        const where = ["i.active = 1"];
        const params = [];
        if (!q.all && !q.q)
            where.push("(i.high_alert = 1 OR i.tall_man_name IS NOT NULL OR i.lasa_group IS NOT NULL OR i.max_single_dose IS NOT NULL OR i.max_daily_dose IS NOT NULL OR i.max_single_per_kg IS NOT NULL OR i.max_daily_per_kg IS NOT NULL)");
        if (q.q) {
            const l = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            where.push("(i.name LIKE ? ESCAPE '\\' OR i.selection_name LIKE ? ESCAPE '\\' OR i.active_ingredient LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\')");
            params.push(l, l, l, l);
        }
        return db().all(`SELECT ${ITEM_SAFETY} FROM items i WHERE ${where.join(" AND ")} ORDER BY i.lasa_group IS NULL, i.lasa_group, i.name COLLATE NOCASE LIMIT 500`, params).map(itemView);
    });
    app.get("/items/:id", async (req) => {
        const it = db().get(`SELECT ${ITEM_SAFETY} FROM items i WHERE i.id = ?`, [req.params.id]);
        if (!it)
            throw notFound("Item");
        return itemView(it);
    });
    app.patch("/items/:id", async (req) => {
        requirePerm(req, "safety.rules");
        const id = String(req.params.id);
        const b = parse(zItemSafety, req.body);
        const before = db().get(`SELECT ${ITEM_SAFETY} FROM items i WHERE i.id = ?`, [id]);
        if (!before)
            throw notFound("Item");
        const cols = [["highAlert", "high_alert"], ["tallManName", "tall_man_name"], ["lasaGroup", "lasa_group"], ["doseUnit", "dose_unit"],
            ["maxSingleDose", "max_single_dose"], ["maxDailyDose", "max_daily_dose"], ["maxSinglePerKg", "max_single_per_kg"], ["maxDailyPerKg", "max_daily_per_kg"]];
        const set = cols.filter(([k]) => b[k] !== undefined);
        if (!set.length)
            return itemView(before);
        const after = { ...before, ...Object.fromEntries(set.map(([k]) => [k, b[k]])) };
        const hasLimit = [after.maxSingleDose, after.maxDailyDose, after.maxSinglePerKg, after.maxDailyPerKg].some((v) => v != null);
        if (hasLimit && !after.doseUnit)
            throw new HttpError(400, "Give the unit the dose limits are in (for example mg)");
        db().run(`UPDATE items SET ${set.map(([, c]) => `${c} = ?`).join(", ")} WHERE id = ?`, [...set.map(([k]) => (k === "highAlert" ? (b[k] ? 1 : 0) : b[k])), id]);
        audit(req, "safety.item.update", "item", id, Object.fromEntries(set.map(([k]) => [k, [before[k], k === "highAlert" ? !!b[k] : b[k]]])));
        return itemView(db().get(`SELECT ${ITEM_SAFETY} FROM items i WHERE i.id = ?`, [id]));
    });
    // ---- checking ahead
    /** The alerts an order would raise (the order form shows them before it is saved). */
    app.post("/check", async (req) => {
        requirePerm(req, "orders");
        const b = parse(z.object({
            patientId: z.string().trim().min(1).max(100),
            items: z.array(z.object({ itemId: z.string().trim().min(1), dose: z.string().max(200).nullish(), qtyPerDose: z.number().nullish(),
                frequencyHours: z.number().nullish(), orderType: z.string().max(40).nullish(), orderId: z.number().int().nullish() })).max(100),
        }), req.body);
        const p = patientInLocation(db(), b.patientId, req.ctx.locationId);
        return { alerts: safetyAlerts(db(), { patientId: p.id, candidates: b.items }) };
    });
    // ---- the alert log
    /** Alerts a pharmacist cancelled the work for (the screen tells; nothing was saved or dispensed). */
    app.post("/alerts/cancelled", async (req) => {
        if (!["orders", "walkin", "dispense"].some((p) => can(req.ctx, p)))
            throw new HttpError(403, "Your role does not allow this");
        const b = parse(z.object({
            context: z.enum(["order.create", "order.update", "order.status", "template.apply", "kit.apply", "walkin.dispense", "dispense.manual"]),
            patientId: z.string().trim().max(100).nullish(),
            alerts: z.array(z.object({ kind: z.enum(["allergy", "interaction", "duplicate", "dose", "high_alert", "missing"]), level: z.enum(["info", "warning", "critical"]),
                itemId: z.string().max(40).nullish(), message: z.string().max(500) })).max(50),
        }), req.body);
        // only this pharmacy's patients (the log shows their names); a walk-in without a patient record has none
        if (b.patientId) {
            try {
                patientInLocation(db(), b.patientId, req.ctx.locationId);
            }
            catch {
                b.patientId = null;
            }
        }
        for (const a of b.alerts.filter((x) => x.level !== "info"))
            db().run(`INSERT INTO safety_alerts(at, user_id, location_id, patient_id, item_id, kind, level, message, context, action) VALUES (?,?,?,?,?,?,?,?,?,'cancelled')`, [nowIso(), req.ctx.userId, req.ctx.locationId, b.patientId ?? null, a.itemId ?? null, a.kind, a.level, a.message, b.context]);
        return { ok: true };
    });
    /** The log, newest first: ?from&to (dates) &kind &action &all=1 (every pharmacy, with "Work in any pharmacy"). */
    app.get("/alerts", async (req) => {
        requirePerm(req, "reports");
        const q = parse(z.object({ from: zDate.optional(), to: zDate.optional(), kind: z.string().max(20).optional(), action: z.string().max(20).optional(),
            all: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }), req.query);
        const where = [];
        const params = [];
        if (!(q.all && can(req.ctx, "pharmacies.all"))) {
            where.push("a.location_id = ?");
            params.push(req.ctx.locationId);
        }
        if (q.from) {
            where.push("a.at >= ?");
            params.push(q.from);
        }
        if (q.to) {
            where.push("a.at < date(?, '+1 day')");
            params.push(q.to);
        }
        if (q.kind) {
            where.push("a.kind = ?");
            params.push(q.kind);
        }
        if (q.action) {
            where.push("a.action = ?");
            params.push(q.action);
        }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const rows = db().all(`SELECT a.id, a.at, a.kind, a.level, a.message, a.context, a.action, a.reason, a.ref, a.patient_id AS "patientId", p.name AS "patientName",
              a.item_id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName", u.display_name AS "user", c.display_name AS "checkedBy", l.name AS "location"
       FROM safety_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.checked_by LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN items i ON i.id = a.item_id LEFT JOIN locations l ON l.id = a.location_id ${w} ORDER BY a.at DESC, a.id DESC LIMIT ?`, [...params, q.limit ?? 500]);
        const summary = db().all(`SELECT a.kind, a.action, COUNT(*) n FROM safety_alerts a ${w} GROUP BY a.kind, a.action`, params);
        return { rows, summary };
    });
}
