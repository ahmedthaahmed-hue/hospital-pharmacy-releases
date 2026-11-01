import { db } from "../../db/index.js";
import { overview } from "../stock/service.js";
import { now, toLocalDate } from "../../lib/time.js";
const str = (v, max = 100) => (typeof v === "string" ? v.slice(0, max) : undefined);
const date = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const lim = (v, d = 20) => (typeof v === "number" && v > 0 ? Math.min(100, Math.floor(v)) : d);
const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const where = (s, col, all) => (all === true && s.everywhere ? { sql: "1 = 1", args: [] } : { sql: `${col} = ?`, args: [s.locationId] });
export const TOOLS = [
    { name: "dispensing_totals", strict: true,
        description: "Totals of medicines dispensed (returns are negative) between two dates, grouped by day, month, department, item or dispensing type. Answers quantities, number of dispensing lines and number of distinct patients (a count only; fewer than 5 is \"<5\"). Walk-ins and carts are their own departments. Days and months come newest first; truncated: true means more rows exist than the limit.",
        input_schema: { type: "object", additionalProperties: false, required: ["from", "to", "group_by", "item_query", "all_pharmacies", "limit"], properties: {
                from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD (inclusive)" },
                group_by: { type: "string", enum: ["day", "month", "department", "item", "type"] },
                item_query: { type: ["string", "null"], description: "Only items whose name or active ingredient contains this text" },
                all_pharmacies: { type: "boolean", description: "Every pharmacy (only for users who work in all of them), else the user's own" },
                limit: { type: "integer", description: "At most this many rows (largest first for department/item)" }
            } } },
    { name: "stock_levels", strict: true,
        description: "Stock on hand per item in the user's own pharmacy only (never the whole hospital): usable quantity, nearest expiry, whether it is low (below the hospital's threshold), out, or expiring within the given days — as the Stock screen counts them.",
        input_schema: { type: "object", additionalProperties: false, required: ["item_query", "only", "expiring_days", "limit"], properties: {
                item_query: { type: ["string", "null"] }, only: { type: "string", enum: ["all", "low", "out", "expiring"] },
                expiring_days: { type: "integer" }, limit: { type: "integer" }
            } } },
    { name: "patient_counts", strict: true,
        description: "How many active patients each department of the pharmacy has now, and how many active medication orders (counts only).",
        input_schema: { type: "object", additionalProperties: false, required: ["all_pharmacies"], properties: { all_pharmacies: { type: "boolean" } } } },
    { name: "safety_alert_counts", strict: true,
        description: "Counts of patient-safety warnings shown in the user's own pharmacy only (allergy, interaction, duplicate, dose, high-alert) between two dates (YYYY-MM-DD, inclusive), by kind and level, and how often the pharmacist went ahead or cancelled.",
        input_schema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } } },
    { name: "top_ordered_items", strict: true,
        description: "The items with the most active medication orders now in the user's own pharmacy only, with the number of orders (counts only).",
        input_schema: { type: "object", additionalProperties: false, required: ["limit"], properties: { limit: { type: "integer" } } } },
];
/** The tools this user may have: safety warnings only for those who may see the alert log (and with it on). */
export const toolsFor = (s) => TOOLS.filter((t) => t.name !== "safety_alert_counts" || s.alerts);
/** Runs one tool; the answer is JSON text of aggregate rows. */
export function runTool(name, input, s) {
    const d = db();
    if (name === "dispensing_totals") {
        const from = date(input.from), to = date(input.to);
        if (!from || !to)
            return JSON.stringify({ error: "from and to must be YYYY-MM-DD" });
        const w = where(s, "x.location_id", input.all_pharmacies);
        const q = str(input.item_query);
        const keys = { day: "substr(x.at, 1, 10)", month: "substr(x.at, 1, 7)",
            // as Analytics counts them: carts and walk-ins apart from the wards, a patient by their department now
            department: "CASE WHEN x.type = 'cart' THEN 'Carts and ward stock' WHEN x.type = 'walkin' OR p.id IS NULL THEN 'Walk-ins and outside patients' ELSE COALESCE(dep.name, 'No department') END",
            item: "COALESCE(i.selection_name, i.name)", type: "x.type" };
        const g = String(input.group_by);
        const key = Object.hasOwn(keys, g) ? keys[g] : keys.day;
        // the newest days first, the largest departments and items first: what is cut off by the limit is the least of it
        const order = g === "department" || g === "item" ? "qty DESC" : "key DESC";
        const limit = lim(input.limit, 31);
        const rows = d.all(`SELECT ${key} AS key, ROUND(SUM(CASE WHEN x.type = 'return' THEN -x.qty ELSE x.qty END), 3) AS qty,
        SUM(CASE WHEN x.type <> 'return' THEN 1 ELSE 0 END) AS lines, COUNT(DISTINCT CASE WHEN x.type <> 'return' THEN x.patient_id END) AS patients
      FROM dispenses x JOIN items i ON i.id = x.item_id LEFT JOIN patients p ON p.id = x.patient_id LEFT JOIN departments dep ON dep.id = p.department_id
      WHERE ${w.sql} AND x.at >= ? AND x.at < date(?, '+1 day') ${q ? "AND (i.name LIKE ? ESCAPE '\\' OR i.selection_name LIKE ? ESCAPE '\\' OR i.active_ingredient LIKE ? ESCAPE '\\')" : ""}
      GROUP BY key ORDER BY ${order} LIMIT ?`, [...w.args, from, to, ...(q ? [like(q), like(q), like(q)] : []), limit + 1]);
        // a handful of patients on one day, ward and item could point to someone: fewer than 5 is said as "<5"
        const out = rows.slice(0, limit).map((r) => ({ ...r, patients: r.patients > 0 && r.patients < 5 ? "<5" : r.patients }));
        return JSON.stringify({ pharmacies: w.sql === "1 = 1" ? "all" : "this pharmacy only", truncated: rows.length > limit, rows: out });
    }
    if (name === "stock_levels") {
        const q = str(input.item_query)?.toLowerCase();
        const days = typeof input.expiring_days === "number" && input.expiring_days > 0 ? Math.min(3650, input.expiring_days) : 90;
        const soon = toLocalDate(new Date(now().getTime() + days * 86_400_000));
        // the Stock screen's own figures, so "low" and "out" mean the same here as there
        const rows = overview(d, s.locationId).filter((r) => r.active && (r.stocked || r.usable > 0) && (!q || [r.name, r.selectionName].some((n) => n?.toLowerCase().includes(q))))
            .map((r) => ({ item: r.selectionName || r.name, unit: r.unit, usable: r.usable, nearest_expiry: r.nearestExpiry, low: r.low, out: r.out }));
        const pick = rows.filter((r) => input.only === "low" ? r.low : input.only === "out" ? r.out
            : input.only === "expiring" ? !!r.nearest_expiry && r.nearest_expiry <= soon : true);
        const limit = lim(input.limit, 40);
        return JSON.stringify({ pharmacies: "this pharmacy only", count: pick.length, truncated: pick.length > limit, rows: pick.slice(0, limit) });
    }
    if (name === "patient_counts") {
        const w = where(s, "dep.location_id", input.all_pharmacies);
        return JSON.stringify({ rows: d.all(`SELECT dep.name AS department, COUNT(DISTINCT p.id) AS active_patients,
        (SELECT COUNT(*) FROM medication_orders o JOIN patients p2 ON p2.id = o.patient_id WHERE p2.department_id = dep.id AND p2.active = 1 AND o.status = 'active') AS active_orders
      FROM departments dep JOIN patients p ON p.department_id = dep.id AND p.active = 1 WHERE ${w.sql} GROUP BY dep.id ORDER BY active_patients DESC`, w.args) });
    }
    if (name === "safety_alert_counts") {
        if (!s.alerts)
            return JSON.stringify({ error: "This user may not see safety warnings" });
        const from = date(input.from), to = date(input.to);
        if (!from || !to)
            return JSON.stringify({ error: "from and to must be YYYY-MM-DD" });
        return JSON.stringify({ rows: d.all(`SELECT kind, level, action, COUNT(*) AS n FROM safety_alerts WHERE location_id = ? AND at >= ? AND at < date(?, '+1 day')
      GROUP BY kind, level, action ORDER BY n DESC`, [s.locationId, from, to]) });
    }
    if (name === "top_ordered_items") {
        return JSON.stringify({ rows: d.all(`SELECT COALESCE(i.selection_name, i.name) AS item, COUNT(*) AS active_orders FROM medication_orders o
      JOIN items i ON i.id = o.item_id JOIN patients p ON p.id = o.patient_id AND p.active = 1 JOIN departments dep ON dep.id = p.department_id
      WHERE o.status = 'active' AND dep.location_id = ? GROUP BY i.id ORDER BY active_orders DESC LIMIT ?`, [s.locationId, lim(input.limit)]) });
    }
    return JSON.stringify({ error: `Unknown tool ${name}` });
}
