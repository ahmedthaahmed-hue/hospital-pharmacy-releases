// /api/analytics — dashboard aggregates: dispensing overview, stock health (cover / expiry / waste risk) and the cheap
// alert counts polled by the notification bell. Read-only; same location rule as /api/reports (non-admins always see the
// pharmacy their session works as; admins may pass ?locationId= or ?scope=all to aggregate every pharmacy).
// Dispense semantics: returns are rows with type='return' and a positive qty that SUBTRACT; "lines" = non-return rows.
import { heldSql } from "../../core/fefo.js";
import { z } from "zod";
import { db } from "../../db/index.js";
import { HttpError, can, parse, requirePerm, zDate } from "../../lib/http.js";
import { now as clockNow, toLocalDate, addDays, parseLocal } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { settingBool, settingNum, settingStr } from "../../core/settings.js";
export const DAYS = [7, 14, 30, 90, 180, 365];
export const MAX_RANGE_DAYS = 730;
const zDays = z.coerce.number().int()
    .refine((v) => DAYS.includes(v), "The period must be 7, 14, 30, 90, 180 or 365 days")
    .optional();
const zQuery = z.object({
    days: zDays,
    /** Custom range (both or neither); overrides `days`. */
    from: zDate.optional(),
    to: zDate.optional(),
    locationId: z.coerce.number().int().positive().optional(),
    scope: z.enum(["location", "all"]).optional(),
});
/** Validate the query; resolves `days` (preset, custom range length, or the 'analytics.default_days' setting). */
function parseQuery(raw) {
    const q = parse(zQuery, raw);
    if (!!q.from !== !!q.to)
        throw new HttpError(400, "Give both the start and the end of the period");
    if (q.from && q.to) {
        // days after today have no dispensing yet: counting them as empty days dilutes the averages and the comparison
        const today = toLocalDate(clockNow());
        if (q.from > today)
            throw new HttpError(400, "The period starts in the future");
        if (q.to > today)
            q.to = today;
        const n = dayDiff(q.from, q.to) + 1;
        if (n < 1)
            throw new HttpError(400, "The period ends before it starts");
        if (n > MAX_RANGE_DAYS)
            throw new HttpError(400, `A custom period can be at most ${MAX_RANGE_DAYS} days`);
        return { ...q, days: n };
    }
    return { ...q, days: q.days ?? (Number(settingStr("analytics.default_days")) || 30) };
}
/** Analytics thresholds from settings (see core/settings.ts). */
export function thresholds() {
    return {
        coverCritical: settingNum("analytics.cover_critical_days"), coverLow: settingNum("analytics.cover_low_days"),
        targetCover: settingNum("analytics.target_cover_days"), abcA: settingNum("analytics.abc_a") / 100, abcB: settingNum("analytics.abc_b") / 100,
        riskWindow: settingNum("analytics.risk_window_days"), radarDays: settingNum("analytics.radar_days"), deadDays: settingNum("analytics.dead_stock_days"),
        topN: settingNum("analytics.top_n"), sigma: settingNum("analytics.anomaly_sigma"), forecastDays: settingNum("analytics.forecast_days"),
    };
}
// dispensing to emergency carts and ward stock (records, release 1.7): stock for a ward, not for a patient
export const CARTS_NAME = "Carts and ward stock";
export const EXTERNAL_NAME = "Walk-ins";
export const OTHER_NAME = "Other";
const NO_DEPT_NAME = "No department";
export const NO_CLASS_NAME = "Unclassified";
const ALL_NAME = "All pharmacies";
function scopeOf(req, q) {
    if (!can(req.ctx, "pharmacies.all"))
        return { all: false, loc: req.ctx.locationId };
    if (q.scope === "all")
        return { all: true, loc: null };
    return { all: false, loc: q.locationId ?? req.ctx.locationId };
}
/** `alias.location_id = ?` (or nothing for scope=all) + its params. */
function locSql(s, col) {
    return s.all ? { sql: "1=1", params: [] } : { sql: `${col} = ?`, params: [s.loc] };
}
/** Last `days` calendar days ending today (or the custom from..to), inclusive, and the equal-length period before it. */
function rangeOf(days, today = toLocalDate(clockNow()), custom) {
    if (custom) {
        const f = parseLocal(custom.from);
        return { start: custom.from, end: custom.to, days, prevStart: toLocalDate(addDays(f, -days)), prevEnd: toLocalDate(addDays(f, -1)) };
    }
    const t = parseLocal(today);
    const start = toLocalDate(addDays(t, -(days - 1)));
    const prevEnd = toLocalDate(addDays(t, -days));
    const prevStart = toLocalDate(addDays(t, -(2 * days - 1)));
    return { start, end: today, days, prevStart, prevEnd };
}
const fromTs = (date) => `${date}T00:00:00`;
const toTs = (date) => `${date}T23:59:59`;
const r4 = (n) => Math.round(n * 10000) / 10000;
const ratio = (a, b) => (b ? r4(a / b) : 0);
const dayDiff = (from, to) => Math.round((parseLocal(to).getTime() - parseLocal(from).getTime()) / 86_400_000);
const NET = "CASE WHEN d.type = 'return' THEN -d.qty ELSE d.qty END";
/** KPI block of one period (dispenses only). */
function periodKpis(s, start, end) {
    const l = locSql(s, "d.location_id");
    const r = db().get(`SELECT COALESCE(SUM(d.type <> 'return'), 0) AS lines,
            COALESCE(ROUND(SUM(CASE WHEN d.type <> 'return' THEN d.qty ELSE 0 END), 3), 0) AS dispensedQty,
            COALESCE(ROUND(SUM(CASE WHEN d.type = 'return' THEN d.qty ELSE 0 END), 3), 0) AS returnedQty,
            COALESCE(SUM(d.type = 'return'), 0) AS returnLines,
            COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.patient_id END) AS patients,
            COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.item_id END) AS items,
            COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.walkin_ticket_id END) AS walkinTickets
     FROM dispenses d WHERE ${l.sql} AND d.at >= ? AND d.at <= ?`, [...l.params, fromTs(start), toTs(end)]);
    return { ...r, returnRate: ratio(r.returnLines, r.lines) };
}
/** ABC (Pareto) classes over items' net quantity: A = first `a` of net (default 80 %), B = up to `b` (95 %), C = rest. */
export function abcOf(nets, a = 0.8, b = 0.95) {
    const v = nets.filter((n) => n > 0.0005).sort((a, b) => b - a);
    const total = v.reduce((s, n) => s + n, 0);
    const cls = { a: { items: 0, qty: 0 }, b: { items: 0, qty: 0 }, c: { items: 0, qty: 0 } };
    const pts = [{ x: 0, y: 0 }];
    let cum = 0;
    v.forEach((n, i) => {
        const before = total ? cum / total : 0; // the item crossing a boundary belongs to the class it starts in
        const k = before < a ? "a" : before < b ? "b" : "c";
        cls[k].items++;
        cls[k].qty += n;
        cum += n;
        pts.push({ x: r4((i + 1) / v.length), y: total ? r4(cum / total) : 0 });
    });
    // keep the curve light: ≤ 50 points, always including both ends
    let curve = pts;
    if (pts.length > 50) {
        curve = [];
        for (let j = 0; j < 50; j++)
            curve.push(pts[Math.round((j * (pts.length - 1)) / 49)]);
    }
    const part = (c) => ({ items: c.items, share: ratio(c.qty, total) });
    return { totalItems: v.length, a: part(cls.a), b: part(cls.b), c: part(cls.c), curve };
}
// ---------- stock health ----------
export const EXPIRY_BUCKETS = [
    { key: "expired", label: "Expired" },
    { key: "d30", label: "Within 30 days" },
    { key: "d90", label: "31 to 90 days" },
    { key: "d180", label: "91 to 180 days" },
    { key: "d365", label: "181 to 365 days" },
    { key: "later", label: "More than a year" },
    { key: "none", label: "No expiry date" },
];
const coverStatus = (onHand, doc, th) => onHand <= 0.0005 ? "out" : doc == null ? "ok" : doc < th.coverCritical ? "critical" : doc <= th.coverLow ? "low" : "ok";
/**
 * On-hand (real, non-expired stock — TEMP placeholders never count) and average daily net consumption over the last
 * `days` days, per item (and per item × location for batch-level waste projection).
 */
function coverData(s, days, today, th = thresholds()) {
    const start = toLocalDate(addDays(parseLocal(today), -(days - 1)));
    const ld = locSql(s, "d.location_id");
    const use = db().all(`SELECT d.item_id AS itemId, d.location_id AS loc, SUM(${NET}) AS net
     FROM dispenses d WHERE ${ld.sql} AND d.at >= ? AND d.at <= ? GROUP BY d.item_id, d.location_id`, [...ld.params, fromTs(start), toTs(today)]);
    const lb = locSql(s, "b.location_id");
    const onHandRows = db().all(`SELECT b.item_id AS itemId, SUM(b.qty) AS q FROM batches b
     WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?) AND NOT ${heldSql("b")}
     GROUP BY b.item_id`, [...lb.params, today]);
    const avgByItemLoc = new Map();
    const avgByItem = new Map();
    for (const u of use) {
        const a = Math.max(0, u.net) / days;
        avgByItemLoc.set(`${u.itemId}|${u.loc}`, a);
        avgByItem.set(u.itemId, (avgByItem.get(u.itemId) ?? 0) + a);
    }
    const onHand = new Map(onHandRows.map((r) => [r.itemId, r.q]));
    // Items that run on TEMP placeholder stock only have no known real balance: they are counted under tempBatches
    // ("enter the real batches"), not reported as out of stock.
    const tempOnly = new Set(db().all(`SELECT DISTINCT b.item_id AS itemId FROM batches b WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 1`, lb.params).map((r) => r.itemId));
    const cover = [...avgByItem.entries()].filter(([itemId, a]) => a > 0 && !(tempOnly.has(itemId) && !onHand.has(itemId))).map(([itemId, a]) => {
        const oh = round3(onHand.get(itemId) ?? 0);
        const doc = a > 0 ? Math.round((oh / a) * 10) / 10 : null;
        return { itemId, onHand: oh, avgDaily: round3(a), daysOfCover: doc, status: coverStatus(oh, doc, th) };
    });
    return { cover, avgByItemLoc, onHand };
}
/** Batch-level counts (real stock unless noted). Shared by /stock-health and /alerts. */
function stockCounts(s, today, soonDays = 30) {
    const lb = locSql(s, "b.location_id");
    const d30 = toLocalDate(addDays(parseLocal(today), soonDays));
    const d90 = toLocalDate(addDays(parseLocal(today), 90));
    return db().get(`SELECT COUNT(DISTINCT CASE WHEN b.is_placeholder = 0 THEN b.item_id END) AS items,
            COALESCE(SUM(b.is_placeholder = 0), 0) AS batches,
            COALESCE(SUM(b.is_placeholder = 0 AND b.expiry_date < ?), 0) AS expired,
            COALESCE(SUM(b.is_placeholder = 0 AND b.expiry_date >= ? AND b.expiry_date <= ?), 0) AS expiring30,
            COALESCE(SUM(b.is_placeholder = 0 AND b.expiry_date >= ? AND b.expiry_date <= ?), 0) AS expiring90,
            COALESCE(SUM(b.is_placeholder = 1), 0) AS tempBatches
     FROM batches b WHERE ${lb.sql} AND b.qty > 0`, [today, today, d30, today, d90, ...lb.params]);
}
export const RADAR_MAX_POINTS = 240;
export const RADAR_MAX_GROUPS = 5; // + "Other"
/**
 * Expiry radar: one point per real batch with stock that expires within 365 days (or already has; daysLeft < 0), the
 * soonest RADAR_MAX_POINTS of them (`total` counts them all, before the cut). Sectors = pharmacy name for scope=all, else the item class. Groups are ranked by
 * point count over the returned points (ties by name); groups past the top RADAR_MAX_GROUPS fold into OTHER_NAME.
 */
function expiryRadar(s, today, horizon = 365) {
    const lb = locSql(s, "b.location_id");
    const rows = db().all(`SELECT b.id AS batchId, b.item_id AS itemId, COALESCE(i.name, b.item_id) AS itemName, b.batch_no AS batchNo,
            ${s.all ? "l.name" : "TRIM(i.class)"} AS grp, b.qty, b.expiry_date AS expiry
     FROM batches b LEFT JOIN items i ON i.id = b.item_id LEFT JOIN locations l ON l.id = b.location_id
     WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?
     ORDER BY b.expiry_date, b.id LIMIT ?`, [...lb.params, toLocalDate(addDays(parseLocal(today), horizon)), RADAR_MAX_POINTS]);
    const total = rows.length < RADAR_MAX_POINTS ? rows.length : db().get(`SELECT COUNT(*) AS n FROM batches b
     WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?`, [...lb.params, toLocalDate(addDays(parseLocal(today), horizon))]).n;
    const groupOf = (g) => (g == null || g === "" || (!s.all && g === "-") ? NO_CLASS_NAME : g);
    const counts = new Map();
    for (const r of rows)
        counts.set(groupOf(r.grp), (counts.get(groupOf(r.grp)) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
    const folded = ranked.length > RADAR_MAX_GROUPS;
    const keep = new Set(folded ? ranked.slice(0, RADAR_MAX_GROUPS) : ranked);
    const points = rows.map((r) => {
        const g = groupOf(r.grp);
        return { batchId: r.batchId, itemId: r.itemId, itemName: r.itemName, batchNo: r.batchNo, group: keep.has(g) ? g : OTHER_NAME,
            daysLeft: dayDiff(today, r.expiry), qty: round3(r.qty), expiry: r.expiry };
    });
    return { groups: folded ? [...keep, OTHER_NAME] : ranked, points, total };
}
/** id → name/unit for a list of item ids (chunked IN queries). */
function itemNames(ids) {
    const names = new Map();
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const r of db().all(`SELECT id, name, unit FROM items WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk))
            names.set(r.id, r);
    }
    return names;
}
/** Items whose cover is below `target` days: quantity to bring them to `target` days of the average consumption. */
export function reorderOf(cover, target, names) {
    return cover.filter((c) => c.avgDaily > 0 && (c.daysOfCover ?? 0) < target)
        .map((c) => ({ itemId: c.itemId, name: names.get(c.itemId)?.name ?? c.itemId, unit: names.get(c.itemId)?.unit ?? null,
        onHand: c.onHand, avgDaily: c.avgDaily, daysOfCover: c.daysOfCover, status: c.status,
        suggestedQty: Math.max(1, Math.ceil(target * c.avgDaily - c.onHand)) }))
        .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0) || b.avgDaily - a.avgDaily);
}
/** Real, non-expired stock of items with no (non-return) dispense in the last `days` days, biggest balance first. */
function deadStockOf(s, today, days) {
    const lb = locSql(s, "b.location_id");
    const since = fromTs(toLocalDate(addDays(parseLocal(today), -(days - 1))));
    const ld = locSql(s, "d.location_id");
    return db().all(`SELECT b.item_id AS itemId, COALESCE(MAX(i.name), b.item_id) AS name, MAX(i.unit) AS unit, ROUND(SUM(b.qty), 3) AS onHand,
            COUNT(*) AS batches, MIN(b.expiry_date) AS nearestExpiry,
            (SELECT MAX(d.at) FROM dispenses d WHERE ${ld.sql} AND d.item_id = b.item_id AND d.type <> 'return') AS lastDispensed
     FROM batches b LEFT JOIN items i ON i.id = b.item_id
     WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?)
       AND NOT EXISTS (SELECT 1 FROM dispenses d WHERE ${ld.sql} AND d.item_id = b.item_id AND d.type <> 'return' AND d.at >= ?)
     GROUP BY b.item_id ORDER BY onHand DESC, name`, [...ld.params, ...lb.params, today, ...ld.params, since]);
}
/**
 * Next `horizon` days of dispense lines: weekday profile of the last ≤ 56 days (each weekday's mean ÷ overall mean)
 * scaled by the level of the last 14 days. Needs ≥ 14 days of history with some activity; else [].
 */
export function forecastOf(daily, horizon) {
    const win = daily.slice(-56);
    if (horizon <= 0 || win.length < 14)
        return [];
    const mean = win.reduce((n, d) => n + d.lines, 0) / win.length;
    if (mean <= 0)
        return [];
    const sum = Array(7).fill(0), cnt = Array(7).fill(0);
    for (const d of win) {
        const w = parseLocal(d.date).getDay();
        sum[w] += d.lines;
        cnt[w]++;
    }
    const factor = sum.map((v, w) => (cnt[w] ? v / cnt[w] / mean : 1));
    const recent = win.slice(-14);
    const level = recent.reduce((n, d) => n + d.lines, 0) / recent.length;
    const last = parseLocal(win[win.length - 1].date);
    return Array.from({ length: horizon }, (_, i) => {
        const day = addDays(last, i + 1);
        return { date: toLocalDate(day), lines: Math.round(level * factor[day.getDay()] * 10) / 10 };
    });
}
/** Least-squares slope of lines per day and the change it implies over the window, relative to the mean. */
export function trendOf(daily) {
    const n = daily.length;
    if (n < 3)
        return { slopePerDay: 0, changePct: 0 };
    const mx = (n - 1) / 2, my = daily.reduce((a, d) => a + d.lines, 0) / n;
    let num = 0, den = 0;
    daily.forEach((d, i) => { num += (i - mx) * (d.lines - my); den += (i - mx) ** 2; });
    const slope = den ? num / den : 0;
    return { slopePerDay: r4(slope), changePct: my ? r4((slope * (n - 1)) / my) : 0 };
}
/** Days whose lines are more than `sigma` standard deviations from the window mean (windows ≥ 14 days). ≤ 12, by |z|. */
export function anomaliesOf(daily, sigma) {
    if (daily.length < 14)
        return [];
    const mean = daily.reduce((n, d) => n + d.lines, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((n, d) => n + (d.lines - mean) ** 2, 0) / daily.length);
    if (sd <= 0)
        return [];
    return daily.map((d) => ({ date: d.date, lines: d.lines, z: Math.round(((d.lines - mean) / sd) * 100) / 100 }))
        .filter((d) => Math.abs(d.z) > sigma)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 12)
        .map((d) => ({ ...d, kind: d.z > 0 ? "high" : "low", expected: Math.round(mean * 10) / 10 }));
}
/** Whether this request may see the per-user activity ranking ('analytics.staff_ranking'). */
const staffVisible = (req) => {
    const v = settingStr("analytics.staff_ranking");
    return v === "all" || (v === "admins" && (can(req.ctx, "admin.users") || can(req.ctx, "admin.audit")));
};
export default async function routes(app) {
    // the alerts bell is its own permission; everything else is the Analytics screen
    app.addHook("preHandler", async (req) => requirePerm(req, /\/alerts$/.test(req.routeOptions?.url ?? "") ? "alerts" : "analytics"));
    app.get("/overview", async (req) => {
        const q = parseQuery(req.query);
        const th = thresholds();
        const s = scopeOf(req, q);
        const rg = rangeOf(q.days, undefined, q.from && q.to ? { from: q.from, to: q.to } : undefined);
        const l = locSql(s, "d.location_id");
        const W = `${l.sql} AND d.at >= ? AND d.at <= ?`;
        const P = [...l.params, fromTs(rg.start), toTs(rg.end)];
        const cur = periodKpis(s, rg.start, rg.end);
        const prev = periodKpis(s, rg.prevStart, rg.prevEnd);
        const lp = locSql(s, "dep.location_id");
        const act = db().get(`SELECT COUNT(DISTINCT p.id) AS patients,
              (SELECT COUNT(*) FROM medication_orders o JOIN patients p2 ON p2.id = o.patient_id
                 JOIN departments dep ON dep.id = p2.department_id
               WHERE o.status = 'active' AND p2.active = 1 AND dep.location_id IS NOT NULL AND ${lp.sql}) AS orders
       FROM patients p JOIN departments dep ON dep.id = p.department_id
       WHERE p.active = 1 AND dep.location_id IS NOT NULL AND ${lp.sql}`, [...lp.params, ...lp.params]);
        // daily series, zero-filled
        const dailyRows = db().all(`SELECT substr(d.at, 1, 10) AS date, COALESCE(SUM(d.type <> 'return'), 0) AS lines, ROUND(SUM(${NET}), 3) AS qty,
              COALESCE(SUM(d.type = 'return'), 0) AS returns, COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.patient_id END) AS patients
       FROM dispenses d WHERE ${W} GROUP BY 1`, P);
        const byDate = new Map(dailyRows.map((x) => [x.date, x]));
        const daily = [];
        for (let i = 0, d = parseLocal(rg.start); i < q.days; i++, d = addDays(d, 1)) {
            const k = toLocalDate(d), x = byDate.get(k);
            daily.push({ date: k, lines: x?.lines ?? 0, qty: x?.qty ?? 0, returns: x?.returns ?? 0, patients: x?.patients ?? 0 });
        }
        const byType = db().all(`SELECT d.type AS code, COALESCE(MAX(t.name), d.type) AS name, COUNT(*) AS lines, ROUND(SUM(d.qty), 3) AS qty
       FROM dispenses d LEFT JOIN dispense_types t ON t.code = d.type
       WHERE ${W} AND d.type <> 'return' GROUP BY d.type ORDER BY lines DESC, code`, P);
        // departments: by the patient's current department; walk-ins / dispenses without a patients row are "external"
        const deptRows = db().all(`SELECT CASE WHEN d.type = 'cart' THEN 2 WHEN d.type = 'walkin' OR p.id IS NULL THEN 1 ELSE 0 END AS ext,
              CASE WHEN d.type = 'cart' OR d.type = 'walkin' OR p.id IS NULL THEN NULL ELSE p.department_id END AS departmentId,
              MAX(dep.name) AS name, COUNT(*) AS lines, COUNT(DISTINCT d.patient_id) AS patients
       FROM dispenses d LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN departments dep ON dep.id = p.department_id
       WHERE ${W} AND d.type <> 'return' GROUP BY 1, 2 ORDER BY lines DESC`, P);
        const depts = deptRows.map((r) => ({
            departmentId: r.departmentId, name: r.ext === 2 ? CARTS_NAME : r.ext ? EXTERNAL_NAME : r.departmentId == null ? NO_DEPT_NAME : r.name ?? NO_DEPT_NAME,
            lines: r.lines, patients: r.patients,
        }));
        const byDepartment = depts.length > 8 ? [...depts.slice(0, 8), depts.slice(8).reduce((o, r) => ({ ...o, lines: o.lines + r.lines, patients: o.patients + r.patients }), { departmentId: null, name: OTHER_NAME, lines: 0, patients: 0 })] : depts;
        const itemRows = db().all(`SELECT d.item_id AS itemId, COALESCE(MAX(i.name), d.item_id) AS name, MAX(i.unit) AS unit, ROUND(SUM(${NET}), 3) AS net,
              COALESCE(SUM(d.type <> 'return'), 0) AS lines, COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.patient_id END) AS patients
       FROM dispenses d LEFT JOIN items i ON i.id = d.item_id WHERE ${W} GROUP BY d.item_id ORDER BY net DESC, name`, P);
        // shares are of the positive nets only (as abcOf): a negative net (more returned than dispensed) must not shrink the
        // total and push the top items past 100 %
        const totalNet = itemRows.reduce((n, r) => n + (r.net > 0.0005 ? r.net : 0), 0);
        // "most consumed" lists items with a positive net only (a period of mostly returns can leave zero/negative nets)
        const topItems = itemRows.filter((r) => r.net > 0.0005).slice(0, th.topN).map((r) => ({ ...r, share: ratio(r.net, totalNet) }));
        // returns: items and departments by returned quantity, with their return rate (returned ÷ dispensed qty)
        const retItems = db().all(`SELECT d.item_id AS itemId, COALESCE(MAX(i.name), d.item_id) AS name, MAX(i.unit) AS unit,
              ROUND(SUM(CASE WHEN d.type = 'return' THEN d.qty ELSE 0 END), 3) AS returned,
              ROUND(SUM(CASE WHEN d.type <> 'return' THEN d.qty ELSE 0 END), 3) AS dispensed,
              COALESCE(SUM(d.type = 'return'), 0) AS returnLines
       FROM dispenses d LEFT JOIN items i ON i.id = d.item_id WHERE ${W} GROUP BY d.item_id
       HAVING returned > 0 ORDER BY returned DESC, name LIMIT ?`, [...P, th.topN]);
        const retDepts = db().all(`SELECT CASE WHEN p.id IS NULL THEN NULL ELSE COALESCE(dep.name, '${NO_DEPT_NAME}') END AS name,
              COALESCE(SUM(d.type = 'return'), 0) AS returns, COALESCE(SUM(d.type <> 'return'), 0) AS lines
       FROM dispenses d LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN departments dep ON dep.id = p.department_id
       WHERE ${W} AND d.type <> 'walkin' GROUP BY 1 HAVING returns > 0 ORDER BY returns DESC LIMIT 8`, P);
        const returns = {
            items: retItems.map((r) => ({ ...r, rate: ratio(r.returned, r.dispensed) })),
            departments: retDepts.map((r) => ({ name: r.name ?? EXTERNAL_NAME, returns: r.returns, lines: r.lines, rate: ratio(r.returns, r.lines) })),
        };
        const heatmap = db().all(`SELECT CAST(strftime('%w', substr(d.at, 1, 10)) AS INTEGER) AS weekday, CAST(substr(d.at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS lines
       FROM dispenses d WHERE ${W} AND d.type <> 'return' GROUP BY 1, 2 ORDER BY 1, 2`, P);
        const showStaff = staffVisible(req);
        const users = !showStaff ? [] : db().all(`SELECT d.user_id AS userId, COALESCE(MAX(u.display_name), MAX(u.username), '') AS name, COUNT(*) AS lines
       FROM dispenses d LEFT JOIN users u ON u.id = d.user_id
       WHERE ${W} AND d.type <> 'return' AND d.user_id IS NOT NULL GROUP BY d.user_id ORDER BY lines DESC, name LIMIT 8`, P);
        const locations = can(req.ctx, "pharmacies.all") ? db().all(`SELECT l.id, l.name, COALESCE(SUM(d.type <> 'return'), 0) AS lines, COALESCE(ROUND(SUM(${NET}), 3), 0) AS qty
       FROM locations l LEFT JOIN dispenses d ON d.location_id = l.id AND d.at >= ? AND d.at <= ?
       WHERE l.active = 1 GROUP BY l.id ORDER BY lines DESC, l.name`, [fromTs(rg.start), toTs(rg.end)]) : [];
        const today = toLocalDate(clockNow());
        // complete days only: today is still in progress and a custom range may reach past it (future days are not zeros)
        const complete = daily.filter((x) => x.date < today);
        const locationName = s.all ? ALL_NAME : db().get("SELECT name FROM locations WHERE id = ?", [s.loc])?.name ?? null;
        return {
            range: { start: rg.start, end: rg.end, days: q.days },
            scope: s.all ? "all" : "location",
            locationName,
            kpis: {
                lines: cur.lines, dispensedQty: cur.dispensedQty, returnedQty: cur.returnedQty, returnLines: cur.returnLines, returnRate: cur.returnRate,
                patients: cur.patients, items: cur.items, walkinTickets: cur.walkinTickets,
                activePatients: act.patients, activeOrders: act.orders, avgLinesPerDay: Math.round((cur.lines / q.days) * 10) / 10,
                prev: { lines: prev.lines, dispensedQty: prev.dispensedQty, returnRate: prev.returnRate, patients: prev.patients, items: prev.items, walkinTickets: prev.walkinTickets },
            },
            daily, byType, byDepartment, topItems, heatmap,
            abc: abcOf(itemRows.map((r) => r.net), th.abcA, th.abcB),
            users, staffVisible: showStaff, locations, returns,
            // forecast/trend/anomalies use complete days only: today (still in progress) is left out; the forecast still
            // starts tomorrow. A custom range gets no forecast.
            forecast: q.from ? [] : forecastOf(complete, th.forecastDays + 1).slice(1),
            // what today (in progress) is expected to reach, so the chart can draw the forecast through it
            forecastToday: q.from || !daily.some((x) => x.date === today) ? null : (forecastOf(complete, 1)[0]?.lines ?? null),
            trend: trendOf(complete),
            anomalies: anomaliesOf(complete, th.sigma),
            thresholds: { abcA: th.abcA, abcB: th.abcB, sigma: th.sigma, topN: th.topN },
        };
    });
    app.get("/stock-health", async (req) => {
        const q = parseQuery(req.query);
        const th = thresholds();
        const s = scopeOf(req, q);
        const today = toLocalDate(clockNow());
        const counts = stockCounts(s, today);
        const { cover, avgByItemLoc } = coverData(s, q.days, today, th);
        const lb = locSql(s, "b.location_id");
        const dd = (n) => toLocalDate(addDays(parseLocal(today), n));
        const bucketRows = db().all(`SELECT CASE WHEN b.expiry_date IS NULL THEN 'none' WHEN b.expiry_date < :t THEN 'expired' WHEN b.expiry_date <= :d30 THEN 'd30'
                   WHEN b.expiry_date <= :d90 THEN 'd90' WHEN b.expiry_date <= :d180 THEN 'd180' WHEN b.expiry_date <= :d365 THEN 'd365' ELSE 'later' END AS key,
              COUNT(*) AS batches, ROUND(SUM(b.qty), 3) AS qty
       FROM batches b WHERE ${s.all ? "1=1" : "b.location_id = :l"} AND b.qty > 0 AND b.is_placeholder = 0 GROUP BY 1`, { t: today, d30: dd(30), d90: dd(90), d180: dd(180), d365: dd(365), ...(s.all ? {} : { l: s.loc }) });
        const bk = new Map(bucketRows.map((r) => [r.key, r]));
        const expiryBuckets = EXPIRY_BUCKETS.map((b) => ({ key: b.key, label: b.label, batches: bk.get(b.key)?.batches ?? 0, qty: bk.get(b.key)?.qty ?? 0 }));
        // names for cover rows
        const names = itemNames(cover.map((c) => c.itemId));
        const sortedCover = [...cover].sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || b.avgDaily - a.avgDaily);
        const coverList = sortedCover.slice(0, Math.max(20, th.topN * 2)).map((c) => ({
            itemId: c.itemId, name: names.get(c.itemId)?.name ?? c.itemId, unit: names.get(c.itemId)?.unit ?? null,
            onHand: c.onHand, avgDaily: c.avgDaily, daysOfCover: c.daysOfCover, status: c.status,
        }));
        const riskRows = db().all(`SELECT b.id AS batchId, b.item_id AS itemId, COALESCE(i.name, b.item_id) AS itemName, b.batch_no AS batchNo, b.expiry_date AS expiry,
              b.qty, b.location_id AS loc
       FROM batches b LEFT JOIN items i ON i.id = b.item_id
       WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?`, [...lb.params, dd(th.riskWindow)]);
        const atRiskAll = riskRows.map((b) => {
            const daysLeft = dayDiff(today, b.expiry);
            const avg = avgByItemLoc.get(`${b.itemId}|${b.loc}`) ?? 0;
            const projectedUse = round3(Math.min(b.qty, avg * Math.max(daysLeft, 0)));
            return { batchId: b.batchId, itemId: b.itemId, itemName: b.itemName, batchNo: b.batchNo, expiry: b.expiry, qty: round3(b.qty),
                daysLeft, projectedUse, projectedWaste: round3(b.qty - projectedUse) };
        }).filter((r) => r.projectedWaste > 0.0005)
            .sort((a, b) => b.projectedWaste - a.projectedWaste || a.daysLeft - b.daysLeft);
        const atRisk = atRiskAll.slice(0, Math.max(15, th.topN));
        // the whole queue's size, before the list is cut (the card's sentence and the insight speak of all of it)
        const atRiskTotals = { batches: atRiskAll.length, qty: round3(atRiskAll.reduce((n, r) => n + r.projectedWaste, 0)) };
        const reorder = reorderOf(cover, th.targetCover, names);
        const dead = deadStockOf(s, today, th.deadDays);
        // stock adequacy is over every item with real stock plus the items out of stock (an item used up — or holding only
        // expired batches — has no real batch left, so the batch count alone would leave it out)
        const stocked = new Set(db().all(`SELECT DISTINCT b.item_id AS itemId FROM batches b WHERE ${lb.sql} AND b.qty > 0 AND b.is_placeholder = 0`, lb.params).map((r) => r.itemId));
        const out = cover.filter((c) => c.status === "out");
        return {
            totals: {
                items: counts.items, batches: counts.batches, expired: counts.expired, expiring30: counts.expiring30, expiring90: counts.expiring90,
                outOfStock: out.length,
                assessed: counts.items + out.filter((c) => !stocked.has(c.itemId)).length,
                critical: cover.filter((c) => c.status === "critical").length,
                low: cover.filter((c) => c.status === "low").length,
                tempBatches: counts.tempBatches,
            },
            expiryBuckets, cover: coverList, atRisk, atRiskTotals,
            radar: expiryRadar(s, today, th.radarDays),
            reorder: { total: reorder.length, totalQty: round3(reorder.reduce((n, r) => n + r.suggestedQty, 0)), rows: reorder.slice(0, th.topN * 2) },
            deadStock: { total: dead.length, totalQty: round3(dead.reduce((n, r) => n + r.onHand, 0)), rows: dead.slice(0, th.topN * 2) },
            thresholds: { coverCritical: th.coverCritical, coverLow: th.coverLow, targetCover: th.targetCover, riskWindow: th.riskWindow, radarDays: th.radarDays, deadDays: th.deadDays, windowDays: q.days },
        };
    });
    /** Full reorder suggestion list (for export): every item whose cover is below the target. */
    app.get("/reorder", async (req) => {
        const q = parseQuery(req.query);
        const th = thresholds();
        const s = scopeOf(req, q);
        const { cover } = coverData(s, q.days, toLocalDate(clockNow()), th);
        const rows = reorderOf(cover, th.targetCover, itemNames(cover.map((c) => c.itemId)));
        return { targetCover: th.targetCover, windowDays: q.days, rows };
    });
    /** One item: consumption over the period, where it goes, its batches and cover. */
    app.get("/item/:id", async (req) => {
        const q = parseQuery(req.query);
        const th = thresholds();
        const s = scopeOf(req, q);
        const id = String(req.params.id);
        const item = db().get("SELECT id, name, unit, form, TRIM(class) AS class, active_ingredient AS ingredient FROM items WHERE id = ?", [id]);
        if (!item)
            throw new HttpError(404, "Item not found");
        const today = toLocalDate(clockNow());
        const rg = rangeOf(q.days, today, q.from && q.to ? { from: q.from, to: q.to } : undefined);
        const l = locSql(s, "d.location_id");
        const W = `${l.sql} AND d.item_id = ? AND d.at >= ? AND d.at <= ?`;
        const P = [...l.params, id, fromTs(rg.start), toTs(rg.end)];
        const k = db().get(`SELECT COALESCE(SUM(d.type <> 'return'), 0) AS lines, COALESCE(ROUND(SUM(${NET}), 3), 0) AS net,
              COALESCE(ROUND(SUM(CASE WHEN d.type = 'return' THEN d.qty ELSE 0 END), 3), 0) AS returned,
              COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.patient_id END) AS patients
       FROM dispenses d WHERE ${W}`, P);
        const pk = db().get(`SELECT COALESCE(ROUND(SUM(${NET}), 3), 0) AS net FROM dispenses d WHERE ${l.sql} AND d.item_id = ? AND d.at >= ? AND d.at <= ?`, [...l.params, id, fromTs(rg.prevStart), toTs(rg.prevEnd)]);
        const dailyRows = new Map(db().all(`SELECT substr(d.at, 1, 10) AS date, ROUND(SUM(${NET}), 3) AS qty, COALESCE(SUM(d.type <> 'return'), 0) AS lines
       FROM dispenses d WHERE ${W} GROUP BY 1`, P).map((r) => [r.date, r]));
        const daily = [];
        for (let i = 0, d = parseLocal(rg.start); i < rg.days; i++, d = addDays(d, 1)) {
            const key = toLocalDate(d);
            daily.push({ date: key, qty: dailyRows.get(key)?.qty ?? 0, lines: dailyRows.get(key)?.lines ?? 0 });
        }
        const byDepartment = db().all(`SELECT CASE WHEN d.type = 'walkin' OR p.id IS NULL THEN NULL ELSE COALESCE(dep.name, '${NO_DEPT_NAME}') END AS name,
              ROUND(SUM(${NET}), 3) AS qty, COUNT(DISTINCT CASE WHEN d.type <> 'return' THEN d.patient_id END) AS patients
       FROM dispenses d LEFT JOIN patients p ON p.id = d.patient_id LEFT JOIN departments dep ON dep.id = p.department_id
       WHERE ${W} GROUP BY 1 ORDER BY qty DESC LIMIT 8`, P).map((r) => ({ ...r, name: r.name ?? EXTERNAL_NAME }));
        const byType = db().all(`SELECT d.type AS code, COALESCE(MAX(t.name), d.type) AS name, COUNT(*) AS lines, ROUND(SUM(d.qty), 3) AS qty
       FROM dispenses d LEFT JOIN dispense_types t ON t.code = d.type WHERE ${W} GROUP BY d.type ORDER BY lines DESC`, P);
        const lb = locSql(s, "b.location_id");
        const batches = db().all(`SELECT b.id AS batchId, b.batch_no AS batchNo, b.expiry_date AS expiry, b.qty, l.name AS location, b.is_placeholder AS temp
       FROM batches b JOIN locations l ON l.id = b.location_id
       WHERE ${lb.sql} AND b.item_id = ? AND b.qty > 0 ORDER BY b.is_placeholder, b.expiry_date IS NULL, b.expiry_date, b.id LIMIT 40`, [...lb.params, id])
            .map((b) => ({ ...b, qty: round3(b.qty), temp: !!b.temp, daysLeft: b.expiry ? dayDiff(today, b.expiry) : null }));
        const last = db().get(`SELECT MAX(d.at) AS at FROM dispenses d WHERE ${l.sql} AND d.item_id = ? AND d.type <> 'return'`, [...l.params, id])?.at ?? null;
        const { cover } = coverData(s, q.days, today, th);
        const c = cover.find((x) => x.itemId === id);
        const onHand = round3(batches.filter((b) => !b.temp && (b.daysLeft == null || b.daysLeft >= 0)).reduce((n, b) => n + b.qty, 0));
        // Items running on TEMP placeholder stock only are left out of coverData; their cover is computed here, flagged tempOnly.
        const avgDaily = c?.avgDaily ?? round3(Math.max(0, k.net) / rg.days);
        const tempOnly = onHand <= 0.0005 && batches.some((b) => b.temp);
        const daysOfCover = c?.daysOfCover ?? (avgDaily > 0 ? Math.round((onHand / avgDaily) * 10) / 10 : null);
        return {
            item, range: { start: rg.start, end: rg.end, days: rg.days },
            kpis: { ...k, returnRate: ratio(k.returned, k.net + k.returned), prevNet: pk.net },
            daily, byDepartment, byType, batches, lastDispensed: last,
            cover: { onHand, avgDaily, daysOfCover: tempOnly ? null : daysOfCover, status: c?.status ?? (tempOnly ? "ok" : coverStatus(onHand, daysOfCover, th)), tempOnly,
                suggestedQty: !tempOnly && avgDaily > 0 ? Math.max(0, Math.ceil(th.targetCover * avgDaily - onHand)) : 0, targetCover: th.targetCover },
        };
    });
    /**
     * Cheap counts for the notification bell — always the session's pharmacy, 30-day consumption window. Kinds switched
     * off in settings (alerts.*) report 0; "expiring" uses 'alerts.expiring_days'.
     */
    app.get("/alerts", async (req) => {
        const s = { all: false, loc: req.ctx.locationId };
        const today = toLocalDate(clockNow());
        const soon = settingNum("alerts.expiring_days");
        const c = stockCounts(s, today, soon);
        const { cover } = coverData(s, 30, today);
        const on = (k, n) => (settingBool(`alerts.${k}`) ? n : 0);
        return {
            expired: on("expired", c.expired), expiring30: on("expiring", c.expiring30),
            outOfStock: on("out_of_stock", cover.filter((x) => x.status === "out").length),
            critical: on("critical", cover.filter((x) => x.status === "critical").length),
            tempBatches: on("temp", c.tempBatches),
            expiringDays: soon,
        };
    });
}
