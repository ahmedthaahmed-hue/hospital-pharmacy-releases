import { z } from "zod";
import { db } from "../../db/index.js";
import { parse, can, requirePerm, audit, notFound, zDate, zTime, HttpError } from "../../lib/http.js";
import { normHHMM } from "../../core/schedule.js";
import { buildPlan, executeRun } from "./plan.js";
const zRun = z.object({
    mode: z.enum(["day", "selected_times"]).default("day"),
    date: zDate.nullish(),
    doseTimes: z.array(zTime).max(48).optional().transform((v) => (v ? [...new Set(v.map(normHHMM))].sort() : [])),
    scope: z.object({
        patientId: z.string().trim().max(100).nullish().transform((v) => v || null),
        departmentId: z.coerce.number().int().positive().nullish(),
    }).default({ patientId: null }),
    orderTypes: z.array(z.string().max(40)).max(20).optional().transform((v) => v ?? []),
    reportType: z.enum(["medication", "patient"]).default("medication"),
});
const zExecute = zRun.extend({
    dispense: z.boolean().default(false),
    print: z.boolean().default(true),
    orderIds: z.array(z.coerce.number().int().positive()).max(20000).nullish(),
    force: z.boolean().optional(), // confirm a dispensing run for a medical day that has ended
});
function runRow(r) {
    const summary = JSON.parse(r.summary);
    return {
        id: r.id, at: r.at, userName: r.user_name ?? null, mode: r.mode, windowLabel: summary.window?.label ?? null,
        doseTimes: summary.doseTimes ?? [], dispense: !!summary.dispense, print: !!summary.print, reportType: summary.reportType,
        scope: summary.scope ?? {}, orderTypes: summary.orderTypes ?? [], counts: summary.counts,
    };
}
function loadRun(req, id) {
    const r = db().get(`SELECT r.*, u.display_name AS user_name FROM dispense_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`, [id]);
    if (!r)
        throw notFound("Run");
    if (r.location_id !== req.ctx.locationId && !can(req.ctx, "pharmacies.all"))
        throw new HttpError(403, "This run belongs to another pharmacy");
    const summary = JSON.parse(r.summary);
    summary.userName = r.user_name ?? null;
    return { summary, labels: r.labels ? JSON.parse(r.labels) : { kind: "medication", items: [] }, params: JSON.parse(r.params) };
}
export default async function routes(app) {
    /** Patients the run can be scoped to: active patients of this pharmacy. */
    app.get("/patients", async (req) => db().all(`SELECT p.id, p.name, d.id AS departmentId, d.name AS department
       FROM patients p JOIN departments d ON d.id = p.department_id
       WHERE p.active = 1 AND d.location_id = ? ORDER BY p.name, p.id`, [req.ctx.locationId]));
    /** What the run would do — nothing is changed. */
    app.post("/preview", async (req) => {
        const p = parse(zRun, req.body);
        return buildPlan(db(), req.ctx.locationId, p).plan;
    });
    /** Dispense (one transaction per order) and/or build labels; stores the run summary. */
    app.post("/execute", async (req) => {
        requirePerm(req, "runs");
        const b = parse(zExecute, req.body);
        const { dispense, print, orderIds, force, ...p } = b;
        const res = executeRun(db(), req.ctx.locationId, p, { dispense, print, orderIds: orderIds ?? null, userId: req.ctx.userId, force,
            replay: req.ctx.token === "replay" });
        res.summary.userName = req.ctx.displayName;
        audit(req, res.summary.dispense ? "runs.dispense" : "runs.print", "dispense_run", res.summary.runId, {
            mode: res.summary.mode, date: res.summary.window.label, doseTimes: res.summary.doseTimes, counts: res.summary.counts,
            ...(force && res.summary.dispense && !res.summary.window.isCurrent ? { force: true } : {}),
        });
        return res;
    });
    /** Run history of this pharmacy, newest first. */
    app.get("/", async (req) => {
        const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), date: zDate.optional() }), req.query);
        const rows = db().all(`SELECT r.id, r.at, r.mode, r.summary, u.display_name AS user_name
       FROM dispense_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.location_id = ?${q.date ? " AND substr(r.at,1,10) = ?" : ""}
       ORDER BY r.at DESC, r.rowid DESC LIMIT ?`, q.date ? [req.ctx.locationId, q.date, q.limit] : [req.ctx.locationId, q.limit]);
        return rows.map(runRow);
    });
    app.get("/:id", async (req) => {
        const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
        return loadRun(req, id);
    });
    /** Labels of a past run for reprinting — never dispenses again. */
    app.post("/:id/reprint", async (req) => {
        const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
        const r = loadRun(req, id);
        audit(req, "runs.reprint", "dispense_run", id, { labels: r.labels.items.length });
        return r.labels;
    });
}
