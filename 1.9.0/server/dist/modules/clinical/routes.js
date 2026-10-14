import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, notFound, parse, requirePerm, zId } from "../../lib/http.js";
import { addDays, nowIso, now as clockNow, parseLocal, toLocalDate } from "../../lib/time.js";
import { round3 } from "../../core/schedule.js";
import { settingStr } from "../../core/settings.js";
import { patientInLocation } from "../patients/scope.js";
export default async function routes(app) {
    // ======== verification of orders
    app.get("/verify", async (req) => {
        const rows = db().all(`SELECT o.id, o.patient_id AS "patientId", p.name AS "patientName", d.name AS department, o.item_id AS "itemId",
         COALESCE(i.selection_name, i.name) AS "itemName", i.unit, i.high_alert AS "highAlert", o.dose, o.qty_per_dose AS "qtyPerDose",
         o.frequency_hours AS "frequencyHours", o.route, o.order_type AS "orderType", o.start_date AS "startDate", o.first_dose_time AS "firstDoseTime",
         o.duration_days AS "durationDays", o.notes, o.status, o.created_at AS "createdAt", o.updated_at AS "updatedAt", o.written_by AS "writtenById",
         p.weight_kg AS "weightKg", p.dob, p.sex, p.allergy_status AS "allergyStatus",
         (SELECT COUNT(*) FROM patient_allergies a WHERE a.patient_id = p.id) AS allergies
       FROM medication_orders o JOIN patients p ON p.id = o.patient_id JOIN departments d ON d.id = p.department_id JOIN items i ON i.id = o.item_id
       WHERE o.verified_at IS NULL AND o.status <> 'stopped' AND p.active = 1 AND d.location_id = ?
       ORDER BY o.updated_at`, [req.ctx.locationId]);
        const names = new Map(db().all("SELECT id, display_name FROM users").map((u) => [u.id, u.display_name]));
        return {
            mode: settingStr("orders.verification"),
            rows: rows.map((r) => ({ ...r, highAlert: !!r.highAlert, writtenBy: r.writtenById ? names.get(r.writtenById) ?? null : null, mine: r.writtenById === req.ctx.userId })),
        };
    });
    /** A second pharmacist checks the order (dose, frequency, route, the patient's allergies and other orders) and verifies it. */
    app.post("/verify", async (req) => {
        requirePerm(req, "orders.verify");
        const b = parse(z.object({ orderIds: z.array(zId).min(1).max(500) }), req.body);
        const d = db();
        const done = [], own = [];
        d.tx(() => {
            for (const id of b.orderIds) {
                const o = d.get("SELECT id, patient_id, verified_at, written_by FROM medication_orders WHERE id = ?", [id]);
                if (!o)
                    throw notFound("Order");
                patientInLocation(d, o.patient_id, req.ctx.locationId);
                if (o.verified_at)
                    continue;
                if (o.written_by === req.ctx.userId) {
                    own.push(id);
                    continue;
                }
                d.run("UPDATE medication_orders SET verified_at = ?, verified_by = ? WHERE id = ?", [nowIso(), req.ctx.userId, id]);
                audit(req, "order.verify", "order", id);
                done.push(id);
            }
        });
        if (!done.length && own.length)
            throw new HttpError(403, "A second pharmacist verifies: you wrote or last changed this order", { code: "own_order" });
        return { verified: done, own };
    });
    // ======== history across stays
    /**
     * A patient's stays — from being added (or restored) to being discharged — newest first, with the medicines given in
     * each (dispensed less returned) and the orders written. The current stay is open.
     */
    app.get("/patients/:id/stays", async (req) => {
        const id = String(req.params.id);
        const p = patientInLocation(db(), id, req.ctx.locationId); // as the patient's other records: this pharmacy's patients only
        const events = db().all(`SELECT at, action FROM audit_log WHERE entity = 'patient' AND entity_id = ? AND action IN ('patient.create','patient.reactivate','patient.deactivate') ORDER BY at, id`, [id]);
        const stays = [];
        let open = events.some((e) => e.action === "patient.create") ? null : p.created_at; // imported before the audit log
        for (const e of events) {
            if (e.action === "patient.deactivate") {
                if (open) {
                    stays.push({ from: open, to: e.at });
                    open = null;
                }
            }
            else if (!open)
                open = e.at;
        }
        if (open || (!stays.length && p.active))
            stays.push({ from: open ?? p.created_at, to: p.active ? null : p.updated_at });
        const d = db();
        const out = stays.reverse().map((s) => {
            const end = s.to ?? "9999-12-31";
            const given = d.all(`SELECT x.item_id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName", i.unit,
           ROUND(SUM(CASE WHEN x.type = 'return' THEN -x.qty ELSE x.qty END), 3) AS qty, MIN(x.at) AS "firstAt", MAX(x.at) AS "lastAt"
         FROM dispenses x JOIN items i ON i.id = x.item_id WHERE x.patient_id = ? AND x.at >= ? AND x.at <= ?
         GROUP BY x.item_id HAVING qty > 0.0005 ORDER BY "firstAt"`, [id, s.from, end]);
            const orders = d.all(`SELECT o.id, COALESCE(i.selection_name, i.name) AS "itemName", o.dose, o.frequency_hours AS "frequencyHours", o.route, o.status, o.created_at AS "createdAt"
         FROM medication_orders o JOIN items i ON i.id = o.item_id WHERE o.patient_id = ? AND o.created_at >= ? AND o.created_at <= ? ORDER BY o.created_at`, [id, s.from, end]);
            const days = Math.max(1, Math.round(((s.to ? parseLocal(s.to.slice(0, 19)) : clockNow()).getTime() - parseLocal(s.from.slice(0, 19)).getTime()) / 86_400_000));
            return { ...s, days, current: !s.to, given, orders };
        });
        return { patientId: id, stays: out };
    });
    // ======== diversion watch
    /**
     * Controlled medicines at this pharmacy over a period, per user: doses given, returns, stock adjustments, and the
     * counts they made or witnessed with a difference — with each user's share against the others'. A user well above the
     * rest is flagged for a look (not an accusation: night shifts and ICU staff give more).
     */
    app.get("/diversion", async (req) => {
        requirePerm(req, "records");
        if (!can(req.ctx, "reports"))
            requirePerm(req, "reports");
        const q = parse(z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }), req.query);
        const since = toLocalDate(addDays(clockNow(), -q.days));
        const loc = req.ctx.locationId;
        const d = db();
        const rows = d.all(`SELECT u.id AS "userId", u.display_name AS "user",
         SUM(CASE WHEN x.type <> 'return' THEN x.qty ELSE 0 END) AS given, SUM(CASE WHEN x.type = 'return' THEN x.qty ELSE 0 END) AS returned,
         COUNT(DISTINCT CASE WHEN x.type <> 'return' THEN x.id END) AS lines,
         SUM(CASE WHEN x.type = 'manual' THEN 1 ELSE 0 END) AS "noOrder",
         SUM(CASE WHEN x.type <> 'return' AND (CAST(substr(x.at, 12, 2) AS INTEGER) >= 22 OR CAST(substr(x.at, 12, 2) AS INTEGER) < 6) THEN 1 ELSE 0 END) AS night
       FROM dispenses x JOIN items i ON i.id = x.item_id JOIN users u ON u.id = x.user_id
       WHERE i.controlled IS NOT NULL AND x.location_id = ? AND x.at >= ? GROUP BY u.id`, [loc, since]);
        const adj = new Map(d.all(`SELECT m.user_id AS "userId", COUNT(*) n, SUM(-m.qty_delta) qty FROM stock_movements m JOIN batches b ON b.id = m.batch_id JOIN items i ON i.id = b.item_id
       WHERE i.controlled IS NOT NULL AND b.location_id = ? AND m.kind = 'adjust' AND m.qty_delta < 0 AND m.at >= ? GROUP BY m.user_id`, [loc, since]).map((r) => [r.userId, r]));
        const counts = new Map(d.all(`SELECT u AS "userId", COUNT(*) n, SUM(short) short FROM (
         SELECT user_id u, CASE WHEN counted < expected - 0.0005 THEN 1 ELSE 0 END short FROM cd_checks WHERE location_id = ? AND at >= ?
         UNION ALL SELECT witness_id u, CASE WHEN counted < expected - 0.0005 THEN 1 ELSE 0 END FROM cd_checks WHERE location_id = ? AND at >= ?) GROUP BY u`, [loc, since, loc, since]).map((r) => [r.userId, r]));
        // someone who only wrote stock off or counted short is listed too (no doses given)
        const names = new Map(d.all("SELECT id, display_name FROM users").map((u) => [u.id, u.display_name]));
        for (const id of new Set([...adj.keys(), ...counts.keys()]))
            if (id != null && !rows.some((r) => r.userId === id) && names.has(id))
                rows.push({ userId: id, user: names.get(id), given: 0, returned: 0, lines: 0, noOrder: 0, night: 0 });
        const all = rows.map((r) => ({ ...r, given: round3(r.given ?? 0), returned: round3(r.returned ?? 0),
            adjustments: adj.get(r.userId)?.n ?? 0, adjustedQty: round3(adj.get(r.userId)?.qty ?? 0),
            countsShort: counts.get(r.userId)?.short ?? 0, counts: counts.get(r.userId)?.n ?? 0,
            returnRate: r.given ? Math.round((r.returned / r.given) * 100) : 0 }));
        // flags: well above the median of the others
        const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
        const noOrderShare = (r) => (r.lines ? r.noOrder / r.lines : 0);
        const giving = all.filter((r) => r.lines > 0); // the medians are of those who gave doses
        const mGiven = med(giving.map((r) => r.given)), mReturn = med(giving.map((r) => r.returnRate)), mNight = med(giving.map((r) => r.night)), mNoOrder = med(giving.map(noOrderShare));
        const out = all.map((r) => {
            const flags = [];
            if (giving.length >= 3 && mGiven > 0 && r.given > mGiven * 2.5)
                flags.push("Gives far more than the others");
            if (r.lines > 0 && r.returnRate >= Math.max(20, mReturn * 2))
                flags.push("Many returns");
            if (giving.length >= 3 && r.night > Math.max(5, mNight * 3))
                flags.push("Many night-time doses");
            // doses given by hand with no order behind them (manual dispensing), well above what is usual here (some wards
            // give stock doses by hand); an order deleted since does not make its doses count here
            if (r.noOrder > 0 && noOrderShare(r) >= (giving.length >= 3 ? Math.max(0.2, mNoOrder * 2) : 0.2))
                flags.push("Doses without an order");
            if (r.adjustments > 0)
                flags.push("Stock written off");
            if (r.countsShort > 0)
                flags.push("Counts that came out short");
            return { ...r, flags };
        }).sort((a, b) => b.flags.length - a.flags.length || b.given - a.given);
        return { days: q.days, since, rows: out };
    });
    // ======== forecasting: minimum / maximum levels from use
    /**
     * Suggested levels per item from the last `days` of use at this pharmacy: minimum = what is used while waiting for
     * stock (lead days) plus safety stock (z × the spread of daily use × √lead days); maximum = minimum + one review
     * period of use. Items used on fewer than 5 days are left out (too little to go on).
     */
    app.get("/levels", async (req) => {
        const q = parse(z.object({ days: z.coerce.number().int().min(14).max(365).default(90), leadDays: z.coerce.number().min(1).max(60).default(7),
            reviewDays: z.coerce.number().min(1).max(90).default(14), service: z.coerce.number().refine((v) => [0.9, 0.95, 0.99].includes(v)).default(0.95) }), req.query);
        const z_ = { 0.9: 1.28, 0.95: 1.65, 0.99: 2.33 }[q.service];
        const since = toLocalDate(addDays(clockNow(), -q.days));
        const daily = db().all(`SELECT item_id AS "itemId", substr(at, 1, 10) AS day, SUM(CASE WHEN type = 'return' THEN -qty ELSE qty END) AS qty
       FROM dispenses WHERE location_id = ? AND at >= ? GROUP BY item_id, day`, [req.ctx.locationId, since]);
        const byItem = new Map();
        for (const r of daily) {
            if (!byItem.has(r.itemId))
                byItem.set(r.itemId, []);
            byItem.get(r.itemId).push(Math.max(0, r.qty));
        }
        const items = new Map(db().all(`SELECT i.id, COALESCE(i.selection_name, i.name) AS name, i.unit, l.min_qty AS "min", l.max_qty AS "max",
        (SELECT COALESCE(SUM(qty),0) FROM batches b WHERE b.item_id = i.id AND b.location_id = ? AND b.is_placeholder = 0) AS "onHand"
      FROM items i LEFT JOIN stock_levels l ON l.item_id = i.id AND l.location_id = ?`, [req.ctx.locationId, req.ctx.locationId]).map((r) => [r.id, r]));
        const out = [];
        for (const [itemId, days] of byItem) {
            if (days.length < 5)
                continue;
            const it = items.get(itemId);
            if (!it)
                continue;
            const full = [...days, ...Array(Math.max(0, q.days - days.length)).fill(0)];
            const mean = full.reduce((s, v) => s + v, 0) / full.length;
            if (mean <= 0)
                continue;
            const sd = Math.sqrt(full.reduce((s, v) => s + (v - mean) ** 2, 0) / full.length);
            const min = Math.ceil(mean * q.leadDays + z_ * sd * Math.sqrt(q.leadDays));
            const max = Math.ceil(min + mean * q.reviewDays);
            out.push({ itemId, itemName: it.name, unit: it.unit, perDay: round3(mean), spread: round3(sd), onHand: round3(it.onHand), currentMin: it.min, currentMax: it.max,
                suggestedMin: min, suggestedMax: max, changed: it.min == null || Math.abs((it.min - min) / Math.max(1, min)) > 0.2 });
        }
        return { ...q, rows: out.sort((a, b) => b.perDay - a.perDay) };
    });
    // ======== VEN
    app.post("/ven", async (req) => {
        requirePerm(req, "items");
        const b = parse(z.object({ itemIds: z.array(z.string().trim().min(1)).min(1).max(5000), ven: z.enum(["V", "E", "N"]).nullable() }), req.body);
        const n = db().tx(() => b.itemIds.reduce((s, id) => s + db().run("UPDATE items SET ven = ? WHERE id = ?", [b.ven, id]).changes, 0));
        audit(req, "item.ven", "item", null, { ven: b.ven, items: b.itemIds.length });
        return { updated: n };
    });
    /**
     * The ABC × VEN matrix over the period's use at this pharmacy (by value when prices are known for most of it, else by
     * quantity): where the money and the vital medicines are. AN (much spent on non-essentials) is the place to look first.
     */
    app.get("/abc-ven", async (req) => {
        requirePerm(req, "analytics");
        const q = parse(z.object({ days: z.coerce.number().int().min(7).max(730).default(90) }), req.query);
        const since = toLocalDate(addDays(clockNow(), -q.days));
        const rows = db().all(`SELECT i.id AS "itemId", COALESCE(i.selection_name, i.name) AS "itemName", i.ven, i.unit_price AS price,
         SUM(CASE WHEN x.type = 'return' THEN -x.qty ELSE x.qty END) AS qty
       FROM dispenses x JOIN items i ON i.id = x.item_id WHERE x.location_id = ? AND x.at >= ? GROUP BY i.id HAVING qty > 0.0005`, [req.ctx.locationId, since]);
        const priced = rows.filter((r) => r.price != null).length;
        const byValue = rows.length > 0 && priced / rows.length >= 0.8;
        const val = (r) => (byValue ? r.qty * (r.price ?? 0) : r.qty);
        const sorted = [...rows].sort((a, b) => val(b) - val(a));
        const total = sorted.reduce((s, r) => s + val(r), 0);
        let cum = 0;
        const classed = sorted.map((r) => {
            const before = total ? cum / total : 0;
            cum += val(r);
            return { ...r, qty: round3(r.qty), value: byValue ? round3(val(r)) : null, abc: before < 0.8 ? "A" : before < 0.95 ? "B" : "C", ven: r.ven ?? null };
        });
        const cell = (a, v) => classed.filter((r) => r.abc === a && (r.ven ?? null) === v);
        const matrix = ["A", "B", "C"].map((a) => ({ abc: a, cells: ["V", "E", "N", null].map((v) => {
                const list = cell(a, v);
                return { ven: v, items: list.length, share: total ? Math.round((list.reduce((s, r) => s + val(r), 0) / total) * 1000) / 10 : 0 };
            }) }));
        return { days: q.days, by: byValue ? "value" : "quantity", matrix, items: classed, unclassified: classed.filter((r) => !r.ven).length };
    });
}
