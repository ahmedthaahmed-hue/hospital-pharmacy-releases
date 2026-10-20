import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, can, HttpError, notFound, parse, requirePerm, zDate, zId, zOptStr } from "../../lib/http.js";
import { nowIso } from "../../lib/time.js";
import { settingStr } from "../../core/settings.js";
import { requireFeature } from "../../core/feature-gate.js";
import { isInternal } from "../../platform/hub.js";
import { nodeConfig } from "../../platform/node-config.js";
import { importText, lastInboxPoll, pollInbox, retryWaiting } from "./apply.js";
import { dispensingCsv, exportDispensing, lastDispensingExport } from "./export.js";
const LIST = `
  SELECT h.id, h.received_at AS receivedAt, h.source, h.format, h.kind, h.patient_id AS patientId, h.ref, h.status, h.data, h.error,
    h.item_id AS itemId, i.name AS itemName, h.order_id AS orderId, h.decided_at AS decidedAt, u.display_name AS decidedBy, h.note,
    p.name AS patientName, p.active AS patientActive, dep.name AS department, dep.location_id AS locationId
  FROM his_messages h
  LEFT JOIN items i ON i.id = h.item_id
  LEFT JOIN users u ON u.id = h.decided_by
  LEFT JOIN patients p ON p.id = h.patient_id
  LEFT JOIN departments dep ON dep.id = p.department_id`;
const view = (r) => ({ ...r, data: (() => { try {
        return JSON.parse(r.data);
    }
    catch {
        return null;
    } })() });
export default async function hisRoutes(app) {
    // switched off: 403 feature_off — checked after sign-in (this plugin's hook runs after the session check), so an
    // anonymous caller still gets 401 and learns nothing
    // (work replayed from a pharmacy PC was allowed there when it was done, so it is not refused now)
    app.addHook("onRequest", async (req) => { if (!isInternal(req))
        requireFeature("his_link"); });
    const admin = (req) => requirePerm(req, "admin.settings");
    // the folders and files are the main server's: a pharmacy PC reads what the main server took in
    const mainOnly = () => { if (nodeConfig().role === "pharmacy")
        throw new HttpError(409, "Do this on the main server — it takes in the hospital system's files", { code: "main_server_only" }); };
    app.get("/", async (req) => {
        if (!can(req.ctx, "orders"))
            admin(req);
        const counts = Object.fromEntries(db().all("SELECT status, COUNT(*) AS n FROM his_messages GROUP BY status").map((r) => [r.status, r.n]));
        return { inbox: { folder: settingStr("his.inbox_folder"), last: lastInboxPoll() }, export: { folder: settingStr("his.export_folder"), last: lastDispensingExport() }, counts };
    });
    app.get("/messages", async (req) => {
        const q = parse(z.object({ view: z.enum(["orders", "all"]).default("orders"), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
        if (q.view === "orders") {
            requirePerm(req, "orders");
            // this pharmacy's patients (and, for those who work everywhere, orders for patients not admitted anywhere yet)
            const everywhere = can(req.ctx, "pharmacies.all");
            return db().all(`${LIST} WHERE h.kind IN ('order','cancel','change') AND h.status = 'pending'
          AND (dep.location_id = ? OR (p.id IS NULL AND ?)) ORDER BY h.id LIMIT ?`, [req.ctx.locationId, everywhere ? 1 : 0, q.limit]).map(view);
        }
        admin(req);
        return db().all(`${LIST} ${q.status ? "WHERE h.status = ?" : ""} ORDER BY h.id DESC LIMIT ?`, q.status ? [q.status, q.limit] : [q.limit]).map(view);
    });
    app.post("/messages/:id/reject", async (req) => {
        requirePerm(req, "orders");
        const id = parse(zId, req.params.id);
        const { note } = parse(z.object({ note: zOptStr }), req.body ?? {});
        const r = db().get(`${LIST} WHERE h.id = ?`, [id]);
        if (!r || (r.locationId !== req.ctx.locationId && !can(req.ctx, "pharmacies.all")))
            throw notFound("Message");
        if (r.status !== "pending")
            throw new HttpError(409, "This was already dealt with");
        if (r.kind === "order" && !note)
            throw bad("Write why the order is not accepted");
        // an order is rejected; a cancellation or change of an accepted order is marked done once the pharmacist dealt with it
        db().run("UPDATE his_messages SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'", [r.kind === "order" ? "rejected" : "applied", req.ctx.userId, nowIso(), note ?? null, id]);
        audit(req, r.kind === "order" ? "his.order.reject" : `his.${r.kind}.done`, "patient", r.patientId, { message: id, ref: r.ref, note });
        return { ok: true };
    });
    app.post("/upload", async (req) => {
        admin(req);
        mainOnly();
        const b = parse(z.object({ name: z.string().trim().min(1).max(200), text: z.string().min(1).max(20 * 1024 * 1024) }), req.body);
        const r = importText(b.name, b.text);
        audit(req, "his.upload", "his", null, { name: b.name, ...r });
        return r;
    });
    app.post("/poll", async (req) => { admin(req); mainOnly(); const files = await pollInbox(); return { files, last: lastInboxPoll() }; });
    app.post("/retry", async (req) => { admin(req); mainOnly(); return { applied: retryWaiting() }; });
    app.post("/export", async (req) => {
        admin(req);
        mainOnly();
        if (!settingStr("his.export_folder").trim())
            throw bad("Set the export folder first (Settings → Hospital system link)");
        return { result: exportDispensing(true), last: lastDispensingExport() };
    });
    app.get("/maps", async (req) => {
        if (!can(req.ctx, "orders"))
            admin(req);
        return db().all(`SELECT m.kind, m.code, m.target, COALESCE(i.name, d.name) AS targetName FROM his_maps m
      LEFT JOIN items i ON m.kind = 'item' AND i.id = m.target LEFT JOIN departments d ON m.kind = 'department' AND d.id = CAST(m.target AS INTEGER)
      ORDER BY m.kind, m.code`);
    });
    app.put("/maps", async (req) => {
        const b = parse(z.object({ kind: z.enum(["item", "department"]), code: z.string().trim().min(1).max(100), target: z.string().trim().min(1).max(40) }), req.body);
        // a pharmacist accepting an order may remember which item a drug code is; departments are the admin's
        if (b.kind === "item")
            requirePerm(req, "orders");
        else
            admin(req);
        if (b.kind === "item" ? !db().get("SELECT 1 FROM items WHERE id = ?", [b.target]) : !db().get("SELECT 1 FROM departments WHERE id = ?", [Number(b.target)]))
            throw bad(b.kind === "item" ? "Item not found" : "Department not found");
        db().run("INSERT INTO his_maps(kind, code, target) VALUES (?,?,?) ON CONFLICT(kind, code) DO UPDATE SET target = excluded.target", [b.kind, b.code, b.target]);
        audit(req, "his.map", "his", null, b);
        // what waited for this mapping goes ahead now
        retryWaiting();
        return { ok: true };
    });
    app.delete("/maps/:kind/:code", async (req) => {
        admin(req);
        const p = parse(z.object({ kind: z.enum(["item", "department"]), code: z.string().min(1).max(100) }), req.params);
        if (!db().run("DELETE FROM his_maps WHERE kind = ? AND code = ?", [p.kind, p.code]).changes)
            throw notFound("Mapping");
        audit(req, "his.unmap", "his", null, p);
        return { ok: true };
    });
    app.get("/dispensing.csv", async (req, reply) => {
        requirePerm(req, "reports");
        const q = parse(z.object({ from: zDate, to: zDate }), req.query);
        // this pharmacy's dispensing, or every pharmacy's for those who work everywhere
        const { csv } = dispensingCsv(q.from, q.to, can(req.ctx, "pharmacies.all") ? null : req.ctx.locationId);
        return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="dispensing-${q.from}-${q.to}.csv"`).send(csv);
    });
}
