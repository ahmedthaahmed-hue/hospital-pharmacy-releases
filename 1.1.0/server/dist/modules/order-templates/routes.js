import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, HttpError, notFound, parse, requireWrite, zBool, zId, zTime } from "../../lib/http.js";
import { nowIso, toHHMM, toLocalDate, now as clockNow } from "../../lib/time.js";
import { medicalDay, normHHMM, totalDailyQty } from "../../core/schedule.js";
import { itemsDispensedTodayElsewhere, markEditedAfterDispense, scheduleSettings } from "../orders/view.js";
import { ITEM_NAME, zItemId, zText } from "../walkin/shared.js";
import { patientInLocation } from "../patients/scope.js";
const zName = z.string().trim().min(1, "Enter the template name").max(200);
const zNum = (min = 0) => z.coerce.number().min(min).max(100000).nullish().transform((v) => (v == null ? null : v));
const zPos = z.union([z.literal(""), z.null(), z.coerce.number().positive("Value must be greater than zero").max(100000)])
    .optional().transform((v) => (v === "" ? null : v));
/** 'H:MM' / 'HH:MM' that is a real clock time (zTime alone accepts '25:00' or '07:75', which shift the applied schedule). */
const zClock = zTime.refine((v) => { const [h, m] = v.split(":").map(Number); return h < 24 && m < 60; }, "Invalid time");
const zLineBody = z.object({
    itemId: zItemId,
    secItemId: z.string().trim().max(40).nullish().transform((v) => (v ? v : null)),
    dose: zText(100),
    qtyPerDose: zPos.refine((v) => typeof v !== "number" || v >= 0.001, "Qty per dose must be at least 0.001"),
    frequencyHours: zPos.refine((v) => typeof v !== "number" || v >= 1 / 12, "Frequency must be at least every 5 minutes"),
    dripRate: zNum(0),
    route: zText(100),
    durationDays: zPos,
    orderType: z.string().trim().max(40).nullish(),
    notes: zText(1000),
    firstDoseTime: z.union([zClock, z.literal(""), z.null()]).optional().transform((v) => (v ? normHHMM(v) : v === undefined ? undefined : null)),
    displayOffset: z.coerce.number().int().min(0).max(100000).optional(),
});
function loadTemplate(d, id, locationId) {
    const t = d.get("SELECT id, name, location_id AS locationId, active FROM order_templates WHERE id = ?", [id]);
    if (!t || t.locationId !== locationId)
        throw notFound("Template");
    return { ...t, active: !!t.active };
}
function templateLines(d, id) {
    return d.all(`SELECT l.id, l.item_id AS itemId, ${ITEM_NAME} AS itemName, i.unit AS unit, l.sec_item_id AS secItemId,
            COALESCE(si.selection_name, si.name) AS secItemName, l.dose, l.qty_per_dose AS qtyPerDose,
            l.frequency_hours AS frequencyHours, l.drip_rate AS dripRate, l.route, l.duration_days AS durationDays,
            l.order_type AS orderType, l.notes, l.first_dose_time AS firstDoseTime, l.display_offset AS displayOffset
     FROM order_template_lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN items si ON si.id = l.sec_item_id
     WHERE l.template_id = ? ORDER BY l.display_offset, l.id`, [id]);
}
const full = (d, id, loc) => ({ ...loadTemplate(d, id, loc), lines: templateLines(d, id) });
/** Map a stored order type (code, or legacy display text) to an order_types code; blank → 'regular' (legacy rule). */
function resolveOrderType(d, v) {
    if (!v || !v.trim())
        return "regular";
    const r = d.get("SELECT code FROM order_types WHERE code = ? OR lower(name) = lower(?) OR lower(replace(code,'_','.')) = lower(?)", [v.trim(), v.trim(), v.trim()]);
    return r?.code ?? "regular";
}
function checkOrderType(d, v) {
    if (v == null || v === "")
        return null;
    if (!d.get("SELECT 1 FROM order_types WHERE code = ?", [v]))
        throw bad("Unknown order type");
    return v;
}
function checkItem(d, id, label = "Item") {
    if (!id)
        return;
    if (!d.get("SELECT 1 FROM items WHERE id = ?", [id]))
        throw bad(`${label} not found in the items list`);
}
/** Patient of the session pharmacy only (a template must not read or write another pharmacy's patient). */
function loadPatient(d, patientId, locationId) {
    return patientInLocation(d, patientId, locationId);
}
const zPatientId = z.string().trim().min(1, "Choose the patient").max(100);
/** Apply a template to a patient: append one active order per line, keeping display offsets. Returns rows inserted. */
export function applyOrderTemplate(d, a) {
    return d.tx(() => {
        const t = loadTemplate(d, a.templateId, a.locationId);
        if (!t.active)
            throw bad("This template is inactive");
        const p = loadPatient(d, a.patientId, a.locationId);
        if (!p.active)
            throw bad("Patient is inactive — restore them first");
        const lines = d.all("SELECT * FROM order_template_lines WHERE template_id = ? ORDER BY display_offset, id", [a.templateId]);
        if (!lines.length)
            throw bad("The template has no orders");
        const base = (d.get("SELECT MAX(display_order) m FROM medication_orders WHERE patient_id = ?", [a.patientId])?.m ?? 0) + 1;
        const today = toLocalDate(clockNow());
        const clock = toHHMM(clockNow());
        const now = nowIso();
        // items the patient already received today for orders deleted or stopped since (orders cleared and the template
        // applied again): as for a single new order, today's doses of those items are not dispensed again unasked — the run
        // skips them today and a mid-day dispense asks first (the template's fresh orders used to go out a second time)
        const givenToday = itemsDispensedTodayElsewhere(d, a.patientId, [...new Set(lines.map((l) => l.item_id))]);
        const day = medicalDay(clockNow(), scheduleSettings(d).dayStart).label;
        for (const l of lines) {
            const type = resolveOrderType(d, l.order_type);
            const qpd = l.qty_per_dose != null && l.qty_per_dose > 0 ? l.qty_per_dose : 1;
            const freq = l.frequency_hours != null && l.frequency_hours > 0 ? l.frequency_hours : null;
            let first = l.first_dose_time ? normHHMM(l.first_dose_time) : "06:00";
            // A single dose (Once, or no frequency) whose time has already passed today would start in the past — at the
            // default 06:00 even in the previous medical day, so it is "ended" at once and no run ever dispenses it. It is
            // given now instead, as legacy did (StartDateTime = Now) and operation kits do.
            if ((type === "once" || (!freq && type !== "cont_drip")) && first < clock)
                first = clock;
            const id = d.run(`INSERT INTO medication_orders(patient_id, item_id, sec_item_id, dose, frequency_hours, drip_rate, qty_per_dose, total_daily_qty, route,
           order_type, start_date, first_dose_time, duration_days, status, notes, display_order, is_auto_from_operation, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,0,?,?,?)`, [a.patientId, l.item_id, l.sec_item_id, l.dose, type === "once" ? null : freq, l.drip_rate, qpd, totalDailyQty(qpd, type === "once" ? null : freq), l.route, type, today,
                first, type === "once" ? null : l.duration_days, l.notes,
                base + (l.display_offset ?? 0), a.userId, now, now]).lastId;
            if (givenToday.has(l.item_id))
                markEditedAfterDispense(d, id, day);
        }
        const warnings = [...givenToday.values()].map((name) => `${name} was already dispensed today to this patient for an order that was deleted or stopped — `
            + "today's doses of the new order will need a confirmation before they are dispensed");
        return warnings.length ? { inserted: lines.length, warnings } : { inserted: lines.length };
    });
}
/** Create a template from a patient's current orders (legacy btnSavePatientOrdersAsTemplate_Click, fixed). */
export function templateFromPatient(d, a) {
    return d.tx(() => {
        loadPatient(d, a.patientId, a.locationId);
        const orders = d.all(`SELECT * FROM medication_orders WHERE patient_id = ? AND is_auto_from_operation = 0
         ${a.includeStopped ? "" : "AND status = 'active'"}
       ORDER BY display_order, id`, [a.patientId]);
        if (!orders.length)
            throw bad(a.includeStopped ? "This patient has no orders" : "This patient has no active orders");
        const min = Math.min(...orders.map((o) => o.display_order ?? 0));
        const id = d.run("INSERT INTO order_templates(name, location_id, active) VALUES (?,?,1)", [a.name, a.locationId]).lastId;
        for (const o of orders)
            d.run(`INSERT INTO order_template_lines(template_id, item_id, sec_item_id, dose, qty_per_dose, frequency_hours, drip_rate, route, duration_days,
           order_type, notes, first_dose_time, display_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, o.item_id, o.sec_item_id, o.dose, o.qty_per_dose, o.frequency_hours, o.drip_rate, o.route, o.duration_days, o.order_type, o.notes,
                o.first_dose_time, (o.display_order ?? 0) - min]);
        return { id, name: a.name, lineCount: orders.length };
    });
}
export default async function routes(app) {
    const loc = (req) => req.ctx.locationId;
    /** [{id, name, active, lineCount}] for the current pharmacy, active first. */
    app.get("/", async (req) => db().all(`SELECT t.id, t.name, t.active, (SELECT COUNT(*) FROM order_template_lines l WHERE l.template_id = t.id) AS lineCount
       FROM order_templates t WHERE t.location_id = ? ORDER BY t.active DESC, t.name COLLATE NOCASE`, [loc(req)]).map((t) => ({ ...t, active: !!t.active })));
    app.post("/", async (req) => {
        requireWrite(req);
        const b = parse(z.object({ name: zName }), req.body);
        const d = db();
        const id = d.run("INSERT INTO order_templates(name, location_id, active) VALUES (?,?,1)", [b.name, loc(req)]).lastId;
        audit(req, "order_template.create", "order_template", id, b);
        return full(d, id, loc(req));
    });
    app.post("/from-patient", async (req) => {
        requireWrite(req);
        const b = parse(z.object({ patientId: zPatientId, name: zName, includeStopped: z.boolean().optional() }), req.body);
        const r = templateFromPatient(db(), { ...b, includeStopped: !!b.includeStopped, locationId: loc(req) });
        audit(req, "order_template.from_patient", "order_template", r.id, { patientId: b.patientId, lines: r.lineCount });
        return r;
    });
    app.post("/apply", async (req) => {
        requireWrite(req);
        const b = parse(z.object({ templateId: zId, patientId: zPatientId }), req.body);
        const r = applyOrderTemplate(db(), { ...b, locationId: loc(req), userId: req.ctx.userId });
        audit(req, "order_template.apply", "patient", b.patientId, { templateId: b.templateId, inserted: r.inserted, ...("warnings" in r ? { warnings: r.warnings } : {}) });
        return r;
    });
    app.get("/:id", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        return full(db(), id, loc(req));
    });
    app.patch("/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ name: zName.optional(), active: zBool.optional() }), req.body);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        d.run("UPDATE order_templates SET name = ?, active = ? WHERE id = ?", [b.name ?? t.name, b.active ?? (t.active ? 1 : 0), id]);
        audit(req, "order_template.update", "order_template", id, b);
        return full(d, id, loc(req));
    });
    app.delete("/:id", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        d.tx(() => {
            d.run("DELETE FROM order_template_lines WHERE template_id = ?", [id]);
            d.run("DELETE FROM order_templates WHERE id = ?", [id]);
        });
        audit(req, "order_template.delete", "order_template", id, { name: t.name });
        return { ok: true };
    });
    /** Duplicate as "<name> (Copy)" with every line field. */
    app.post("/:id/duplicate", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        const nid = d.tx(() => {
            const nid = d.run("INSERT INTO order_templates(name, location_id, active) VALUES (?,?,1)", [`${t.name} (Copy)`, loc(req)]).lastId;
            d.run(`INSERT INTO order_template_lines(template_id, item_id, sec_item_id, dose, qty_per_dose, frequency_hours, drip_rate, route, duration_days,
               order_type, notes, first_dose_time, display_offset)
             SELECT ?, item_id, sec_item_id, dose, qty_per_dose, frequency_hours, drip_rate, route, duration_days, order_type, notes, first_dose_time,
               display_offset FROM order_template_lines WHERE template_id = ? ORDER BY display_offset, id`, [nid, id]);
            return nid;
        });
        audit(req, "order_template.duplicate", "order_template", nid, { from: id });
        return full(d, nid, loc(req));
    });
    /** Add a line. Item defaults fill what was not given (frequency → item default or 24 h, route, dose, notes). */
    app.post("/:id/lines", async (req) => {
        requireWrite(req);
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(zLineBody, req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        const item = d.get("SELECT default_dose, default_frequency, default_route, default_notes FROM items WHERE id = ?", [b.itemId]);
        if (!item)
            throw bad("Item not found in the items list");
        checkItem(d, b.secItemId, "Additional item");
        const type = checkOrderType(d, b.orderType) ?? "regular";
        const offset = b.displayOffset ?? (d.get("SELECT MAX(display_offset) m FROM order_template_lines WHERE template_id = ?", [id])?.m ?? -1) + 1;
        const lineId = d.run(`INSERT INTO order_template_lines(template_id, item_id, sec_item_id, dose, qty_per_dose, frequency_hours, drip_rate, route, duration_days,
         order_type, notes, first_dose_time, display_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, b.itemId, b.secItemId ?? null, b.dose ?? item.default_dose ?? null, b.qtyPerDose ?? 1,
            b.frequencyHours !== undefined ? b.frequencyHours : type === "regular" ? item.default_frequency ?? 24 : null,
            b.dripRate ?? null, b.route ?? item.default_route ?? null, b.durationDays ?? null, type, b.notes ?? item.default_notes ?? null,
            b.firstDoseTime ?? "06:00", offset]).lastId;
        audit(req, "order_template.line_add", "order_template_line", lineId, { templateId: id, itemId: b.itemId });
        return full(d, id, loc(req));
    });
    app.patch("/:id/lines/:lineId", async (req) => {
        requireWrite(req);
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const b = parse(zLineBody.partial(), req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        const l = d.get("SELECT * FROM order_template_lines WHERE id = ? AND template_id = ?", [lineId, id]);
        if (!l)
            throw notFound("Line");
        checkItem(d, b.itemId);
        checkItem(d, b.secItemId, "Additional item");
        if (b.orderType !== undefined)
            checkOrderType(d, b.orderType);
        const pick = (v, cur) => (v === undefined ? cur : v);
        d.run(`UPDATE order_template_lines SET item_id=?, sec_item_id=?, dose=?, qty_per_dose=?, frequency_hours=?, drip_rate=?, route=?, duration_days=?,
         order_type=?, notes=?, first_dose_time=?, display_offset=? WHERE id=?`, [b.itemId ?? l.item_id, pick(b.secItemId, l.sec_item_id), pick(b.dose, l.dose), pick(b.qtyPerDose, l.qty_per_dose),
            pick(b.frequencyHours, l.frequency_hours), pick(b.dripRate, l.drip_rate), pick(b.route, l.route), pick(b.durationDays, l.duration_days),
            b.orderType ? b.orderType : l.order_type, pick(b.notes, l.notes), pick(b.firstDoseTime, l.first_dose_time), b.displayOffset ?? l.display_offset, lineId]);
        audit(req, "order_template.line_update", "order_template_line", lineId, b);
        return full(d, id, loc(req));
    });
    /** Move a line up/down in the display order (offsets are renumbered 0..n-1 in the new order). */
    app.post("/:id/lines/:lineId/move", async (req) => {
        requireWrite(req);
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const { dir } = parse(z.object({ dir: z.enum(["up", "down"]) }), req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        d.tx(() => {
            const ids = d.all("SELECT id FROM order_template_lines WHERE template_id = ? ORDER BY display_offset, id", [id]).map((r) => r.id);
            const i = ids.indexOf(lineId);
            if (i < 0)
                throw notFound("Line");
            const j = dir === "up" ? i - 1 : i + 1;
            if (j < 0 || j >= ids.length)
                return;
            [ids[i], ids[j]] = [ids[j], ids[i]];
            ids.forEach((lid, k) => d.run("UPDATE order_template_lines SET display_offset = ? WHERE id = ?", [k, lid]));
        });
        audit(req, "order_template.line_move", "order_template_line", lineId, { templateId: id, dir });
        return full(d, id, loc(req));
    });
    app.delete("/:id/lines/:lineId", async (req) => {
        requireWrite(req);
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const d = db();
        loadTemplate(d, id, loc(req));
        const r = d.run("DELETE FROM order_template_lines WHERE id = ? AND template_id = ?", [lineId, id]);
        if (!r.changes)
            throw new HttpError(404, "Line not found");
        audit(req, "order_template.line_delete", "order_template_line", lineId, { templateId: id });
        return full(d, id, loc(req));
    });
}
