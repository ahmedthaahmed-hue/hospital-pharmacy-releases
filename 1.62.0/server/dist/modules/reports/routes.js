import { z } from "zod";
import { db } from "../../db/index.js";
import { parse, bad, can, requirePerm, zDateTime, zDate } from "../../lib/http.js";
import { now as clockNow, toLocalDate, toLocalIso, addDays, parseLocal } from "../../lib/time.js";
import { ORDER_SELECT } from "../../core/labels.js";
import { endOf, medicalDay, medicalDayOf, planForWindow, totalDailyQty, round3 } from "../../core/schedule.js";
import { available, stockSummary } from "../../core/fefo.js";
import { sendCsv } from "./csv.js";
const zList = z.union([z.string(), z.array(z.string())]).optional()
    .transform((v) => (v == null ? [] : (Array.isArray(v) ? v : v.split(","))).map((s) => s.trim()).filter(Boolean));
const zStr = z.string().trim().max(200).optional().transform((v) => v || undefined);
const base = {
    start: zDateTime.optional(),
    end: zDateTime.optional(),
    types: zList,
    locationId: z.coerce.number().int().positive().optional(),
    format: z.enum(["json", "csv"]).default("json"),
};
const zFilters = z.object({
    ...base,
    patientId: zStr, name: zStr, itemId: zStr,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
/** "Work in any pharmacy" may report on any pharmacy; everyone else on the pharmacy their session works as. */
function locOf(req, q) {
    return q.locationId && can(req.ctx, "pharmacies.all") ? q.locationId : req.ctx.locationId;
}
/** Inclusive range: start at :00 seconds, end at :59 seconds (legacy end default 23:59:59). Default = today. */
function rangeOf(q) {
    const today = toLocalDate(clockNow());
    const start = (q.start ?? `${today}T00:00`).slice(0, 16) + ":00";
    const end = (q.end ?? `${today}T23:59`).slice(0, 16) + ":59";
    if (end < start)
        throw bad("The end of the period must be after its start");
    return { start, end };
}
function dispenseWhere(loc, q) {
    const { start, end } = rangeOf(q);
    const parts = ["d.location_id = ?", "d.at >= ?", "d.at <= ?"];
    const params = [loc, start, end];
    if (q.types.length) {
        parts.push(`d.type IN (${q.types.map(() => "?").join(",")})`);
        params.push(...q.types);
    }
    if (q.patientId) {
        parts.push("d.patient_id = ?");
        params.push(q.patientId);
    }
    if (q.name) {
        parts.push("COALESCE(p.name, d.patient_name, '') LIKE ? ESCAPE '\\'");
        params.push(`%${q.name.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (q.itemId) {
        parts.push("d.item_id = ?");
        params.push(q.itemId);
    }
    return { sql: parts.join(" AND "), params };
}
/** Most days the consumption trend returns. */
const DAILY_MAX = 400;
const PATIENT_NAME = "COALESCE(p.name, d.patient_name, d.patient_id, '')";
const fmtCsvDate = (s) => (s ? s.replace("T", " ").slice(0, 16) : "");
export default async function routes(app) {
    app.addHook("preHandler", async (req) => requirePerm(req, "reports"));
    /** Net quantity per patient + item (returns subtract), HAVING net ≠ 0 — legacy rptDispenseSummary. */
    app.get("/dispense-summary", async (req, reply) => {
        const q = parse(zFilters, req.query);
        const w = dispenseWhere(locOf(req, q), q);
        const rows = db().all(`SELECT d.patient_id AS patientId, MAX(${PATIENT_NAME}) AS patientName, MAX(p.coverage) AS coverage,
              MAX(dep.name) AS department, d.item_id AS itemId, COALESCE(MAX(i.name), d.item_id) AS itemName, MAX(i.unit) AS unit,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN 0 ELSE d.qty END), 3) AS dispensed,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN d.qty ELSE 0 END), 3) AS returned,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN -d.qty ELSE d.qty END), 3) AS netQty
       FROM dispenses d
       LEFT JOIN patients p ON p.id = d.patient_id
       LEFT JOIN departments dep ON dep.id = p.department_id
       LEFT JOIN items i ON i.id = d.item_id
       WHERE ${w.sql}
       GROUP BY IFNULL(d.patient_id, ''), d.item_id
       HAVING ABS(SUM(CASE WHEN d.type = 'return' THEN -d.qty ELSE d.qty END)) > 0.0005
       ORDER BY patientName, itemName`, w.params);
        if (q.format === "csv")
            return sendCsv(reply, "dispense-summary", rows, [
                { header: "Patient ID", value: (r) => r.patientId }, { header: "Patient name", value: (r) => r.patientName },
                { header: "Coverage", value: (r) => r.coverage }, { header: "Department", value: (r) => r.department },
                { header: "Item", value: (r) => r.itemName }, { header: "Item code", value: (r) => r.itemId }, { header: "Unit", value: (r) => r.unit },
                { header: "Dispensed", value: (r) => r.dispensed }, { header: "Returned", value: (r) => r.returned }, { header: "Net", value: (r) => r.netQty },
            ]);
        return {
            range: rangeOf(q), rows,
            totals: { rows: rows.length, patients: new Set(rows.map((r) => r.patientId ?? "")).size, items: new Set(rows.map((r) => r.itemId)).size },
        };
    });
    /** Line-by-line dispense log, newest first, with batch and user — legacy Dispensereportform / qryDispensed. */
    app.get("/dispense-log", async (req, reply) => {
        const q = parse(zFilters, req.query);
        const w = dispenseWhere(locOf(req, q), q);
        const from = `FROM dispenses d
       LEFT JOIN patients p ON p.id = d.patient_id
       LEFT JOIN departments dep ON dep.id = p.department_id
       LEFT JOIN items i ON i.id = d.item_id
       LEFT JOIN batches b ON b.id = d.batch_id
       LEFT JOIN dispense_types t ON t.code = d.type
       LEFT JOIN users u ON u.id = d.user_id
       WHERE ${w.sql}`;
        const select = `SELECT d.id, d.at, d.patient_id AS patientId, ${PATIENT_NAME} AS patientName, p.coverage, dep.name AS department,
              d.item_id AS itemId, COALESCE(i.name, d.item_id) AS itemName, i.unit, d.qty, d.type, COALESCE(t.name, d.type) AS typeName,
              b.batch_no AS batchNo, b.expiry_date AS expiry, b.is_placeholder AS isPlaceholder, u.display_name AS userName,
              d.order_id AS orderId, d.walkin_ticket_id AS ticketId, d.run_id AS runId, d.notes
       ${from} ORDER BY d.at DESC, d.id DESC`;
        if (q.format === "csv") {
            const rows = db().all(`${select} LIMIT 100000`, w.params);
            return sendCsv(reply, "dispense-log", rows, [
                { header: "Date & time", value: (r) => fmtCsvDate(r.at) }, { header: "Patient ID", value: (r) => r.patientId },
                { header: "Patient name", value: (r) => r.patientName }, { header: "Department", value: (r) => r.department },
                { header: "Item", value: (r) => r.itemName }, { header: "Quantity", value: (r) => (r.type === "return" ? -r.qty : r.qty) },
                { header: "Unit", value: (r) => r.unit }, { header: "Dispense type", value: (r) => r.typeName },
                { header: "Batch no.", value: (r) => (r.batchNo ? (r.isPlaceholder ? `TEMP-${r.batchNo}` : r.batchNo) : "") },
                { header: "Expiry", value: (r) => r.expiry }, { header: "User", value: (r) => r.userName }, { header: "Notes", value: (r) => r.notes },
            ]);
        }
        const agg = db().get(`SELECT COUNT(*) AS n,
        ROUND(SUM(CASE WHEN d.type='return' THEN 0 ELSE d.qty END),3) AS dispensed,
        ROUND(SUM(CASE WHEN d.type='return' THEN d.qty ELSE 0 END),3) AS returned,
        COUNT(DISTINCT d.item_id) AS items ${from}`, w.params);
        const rows = db().all(`${select} LIMIT ? OFFSET ?`, [...w.params, q.pageSize, (q.page - 1) * q.pageSize]);
        for (const r of rows)
            r.isPlaceholder = !!r.isPlaceholder;
        return { range: rangeOf(q), rows, total: agg?.n ?? 0, page: q.page, pageSize: q.pageSize, totals: { dispensed: agg?.dispensed ?? 0, returned: agg?.returned ?? 0, items: agg?.items ?? 0 } };
    });
    /** Per patient → item × dispense type sums (returns are their own type, not netted) — legacy patientsdispensereportform. */
    app.get("/patient-totals", async (req, reply) => {
        const q = parse(zFilters, req.query);
        const w = dispenseWhere(locOf(req, q), q);
        const rows = db().all(`SELECT d.patient_id AS patientId, MAX(${PATIENT_NAME}) AS patientName, MAX(p.coverage) AS coverage, MAX(dep.name) AS department,
              d.item_id AS itemId, COALESCE(MAX(i.name), d.item_id) AS itemName, MAX(i.unit) AS unit,
              d.type, COALESCE(MAX(t.name), d.type) AS typeName, ROUND(SUM(d.qty), 3) AS qty, COUNT(*) AS lines
       FROM dispenses d
       LEFT JOIN patients p ON p.id = d.patient_id
       LEFT JOIN departments dep ON dep.id = p.department_id
       LEFT JOIN items i ON i.id = d.item_id
       LEFT JOIN dispense_types t ON t.code = d.type
       WHERE ${w.sql}
       GROUP BY IFNULL(d.patient_id, ''), d.item_id, d.type
       ORDER BY patientName, patientId, itemName, d.type`, w.params);
        if (q.format === "csv")
            return sendCsv(reply, "patient-totals", rows, [
                { header: "Patient ID", value: (r) => r.patientId }, { header: "Patient name", value: (r) => r.patientName },
                { header: "Coverage", value: (r) => r.coverage }, { header: "Department", value: (r) => r.department },
                { header: "Item", value: (r) => r.itemName }, { header: "Unit", value: (r) => r.unit },
                { header: "Dispense type", value: (r) => r.typeName }, { header: "Quantity", value: (r) => r.qty },
            ]);
        return { range: rangeOf(q), rows, totals: { rows: rows.length, patients: new Set(rows.map((r) => r.patientId ?? "")).size } };
    });
    /** Per item totals over a range + daily trend (whole pharmacy, or one item with ?itemId=). */
    app.get("/consumption", async (req, reply) => {
        const q = parse(zFilters, req.query);
        const loc = locOf(req, q);
        const w = dispenseWhere(loc, { ...q, itemId: undefined });
        const items = db().all(`SELECT d.item_id AS itemId, COALESCE(MAX(i.name), d.item_id) AS itemName, MAX(i.unit) AS unit,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN 0 ELSE d.qty END), 3) AS dispensed,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN d.qty ELSE 0 END), 3) AS returned,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN -d.qty ELSE d.qty END), 3) AS net,
              COUNT(DISTINCT d.patient_id) AS patients, COUNT(*) AS lines
       FROM dispenses d LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN items i ON i.id = d.item_id
       WHERE ${w.sql}
       GROUP BY d.item_id ORDER BY net DESC, itemName`, w.params);
        if (q.format === "csv")
            return sendCsv(reply, "item-consumption", items, [
                { header: "Item code", value: (r) => r.itemId }, { header: "Item", value: (r) => r.itemName }, { header: "Unit", value: (r) => r.unit },
                { header: "Dispensed", value: (r) => r.dispensed }, { header: "Returned", value: (r) => r.returned }, { header: "Net", value: (r) => r.net },
                { header: "Patients", value: (r) => r.patients }, { header: "Lines", value: (r) => r.lines },
            ]);
        const wd = dispenseWhere(loc, q);
        const dailyRows = db().all(`SELECT substr(d.at, 1, 10) AS date, ROUND(SUM(CASE WHEN d.type = 'return' THEN -d.qty ELSE d.qty END), 3) AS net, COUNT(*) AS lines
       FROM dispenses d LEFT JOIN patients p ON p.id = d.patient_id WHERE ${wd.sql} GROUP BY 1 ORDER BY 1`, wd.params);
        // fill empty days so the trend reads as a time axis; a long range shows its latest DAILY_MAX days (not its oldest)
        const r = rangeOf(q);
        const byDate = new Map(dailyRows.map((x) => [x.date, x]));
        const daily = [];
        const last = r.end.slice(0, 10);
        const earliest = toLocalDate(addDays(parseLocal(last), -(DAILY_MAX - 1)));
        let d = parseLocal(r.start.slice(0, 10) > earliest ? r.start.slice(0, 10) : earliest);
        for (; toLocalDate(d) <= last; d = addDays(d, 1)) {
            const k = toLocalDate(d);
            daily.push({ date: k, net: byDate.get(k)?.net ?? 0, lines: byDate.get(k)?.lines ?? 0 });
        }
        return { range: r, items, daily, itemId: q.itemId ?? null, totals: { items: items.length, lines: items.reduce((n, x) => n + x.lines, 0) } };
    });
    /** Active medications of the pharmacy by patient or by item, with daily and today's quantities. */
    app.get("/active-meds", async (req, reply) => {
        const q = parse(z.object({
            by: z.enum(["patient", "item"]).default("patient"),
            orderTypes: zList,
            date: zDate.optional(),
            locationId: z.coerce.number().int().positive().optional(),
            format: z.enum(["json", "csv"]).default("json"),
        }), req.query);
        const loc = locOf(req, q);
        const types = q.orderTypes;
        const orders = db().all(`${ORDER_SELECT} WHERE o.status = 'active' AND p.active = 1 AND d.location_id = ?
       ${types.length ? `AND o.order_type IN (${types.map(() => "?").join(",")})` : ""}
       ORDER BY p.name, p.id, CASE WHEN o.order_type = 'regular' THEN 0 ELSE 1 END, o.display_order, o.id`, [loc, ...types]);
        const now = clockNow();
        const ds = db().get("SELECT value FROM settings WHERE key='schedule.day_start'")?.value || "06:00";
        const w = q.date ? medicalDayOf(q.date, ds) : medicalDay(now, ds);
        const rows = orders
            // drop orders whose course ended before this day (incl. Once / kit orders whose single dose is past)
            .map((o) => ({ o, plan: planForWindow(o, w) }))
            .filter(({ plan }) => plan.skip !== "ended")
            .map(({ o, plan }) => {
            const e = endOf(o);
            return {
                orderId: o.id, patientId: o.patient_id, patientName: o.patient_name, department: o.department ?? null,
                itemId: o.item_id, itemName: o.item_name, unit: o.unit ?? null, dose: o.dose ?? null, route: o.route ?? null,
                orderType: o.order_type, frequencyHours: o.frequency_hours ?? null, qtyPerDose: o.qty_per_dose,
                dailyQty: totalDailyQty(o.qty_per_dose, o.order_type === "once" ? null : o.frequency_hours) ?? 0, todayQty: plan.skip ? 0 : plan.qty,
                startDate: o.start_date, firstDoseTime: o.first_dose_time, endAt: e ? toLocalIso(e).slice(0, 16) : null,
                notStarted: plan.skip === "not_started",
            };
        });
        if (q.by === "item") {
            const m = new Map();
            for (const r of rows) {
                let it = m.get(r.itemId);
                if (!it) {
                    it = { itemId: r.itemId, itemName: r.itemName, unit: r.unit, patients: new Set(), orders: 0, dailyQty: 0, todayQty: 0 };
                    m.set(r.itemId, it);
                }
                it.patients.add(r.patientId);
                it.orders++;
                it.dailyQty = round3(it.dailyQty + r.dailyQty);
                it.todayQty = round3(it.todayQty + r.todayQty);
            }
            const items = [...m.values()].map((it) => {
                const s = stockSummary(db(), it.itemId, loc);
                const avail = available(db(), it.itemId, loc); // what FEFO can dispense (real + TEMP placeholder, not expired)
                return {
                    ...it, patients: it.patients.size, available: avail, usable: round3(s.usable), placeholder: round3(s.placeholder),
                    short: round3(Math.max(0, it.todayQty - avail)), realShort: round3(Math.max(0, it.todayQty - s.usable)),
                };
            }).sort((a, b) => a.itemName.localeCompare(b.itemName));
            if (q.format === "csv")
                return sendCsv(reply, "active-meds-by-item", items, [
                    { header: "Item code", value: (r) => r.itemId }, { header: "Item", value: (r) => r.itemName }, { header: "Unit", value: (r) => r.unit },
                    { header: "Patients", value: (r) => r.patients }, { header: "Orders", value: (r) => r.orders },
                    { header: "Daily qty", value: (r) => r.dailyQty }, { header: "Medical day qty", value: (r) => r.todayQty },
                    { header: "Usable on hand", value: (r) => r.usable }, { header: "Temporary stock", value: (r) => r.placeholder },
                ]);
            return { by: "item", day: w.label, items, totals: { items: items.length, orders: rows.length } };
        }
        const cols = [
            { header: "Patient ID", value: (r) => r.patientId }, { header: "Patient name", value: (r) => r.patientName },
            { header: "Department", value: (r) => r.department }, { header: "Item", value: (r) => r.itemName }, { header: "Dose", value: (r) => r.dose },
            { header: "Route", value: (r) => r.route }, { header: "Every (hours)", value: (r) => r.frequencyHours },
            { header: "Qty per dose", value: (r) => r.qtyPerDose }, { header: "Daily qty", value: (r) => r.dailyQty },
            { header: "Medical day qty", value: (r) => r.todayQty }, { header: "Unit", value: (r) => r.unit },
            { header: "Order type", value: (r) => r.orderType }, { header: "Start", value: (r) => r.startDate }, { header: "End", value: (r) => r.endAt },
        ];
        if (q.format === "csv")
            return sendCsv(reply, "active-meds-by-patient", rows, cols);
        return { by: "patient", day: w.label, rows, totals: { orders: rows.length, patients: new Set(rows.map((r) => r.patientId)).size } };
    });
}
