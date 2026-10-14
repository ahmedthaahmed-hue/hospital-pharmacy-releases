// Development only: realistic dispensing activity for the analytics dashboards on the demo database.
//   npx tsx src/db/dev-activity.ts [--db data/pharmacy.sqlite] [--days 120] [--seed 42]
// For every active pharmacy that has departments it writes `dispenses` rows over the last N days for the synthetic
// patients (IDs 9000…) of its departments and the items that have batches there: shift peaks around 06:00 / 12:00 / 18:00,
// a weekend dip (Fri/Sat), a long-tail item popularity (so ABC classes mean something), ~3–6 % returns and walk-in
// tickets. Every row is tagged notes='demo-activity'; re-running first deletes the previous demo rows (idempotent).
// It never changes batches.qty or stock_movements, and refuses to run against a file whose name contains REAL_DATA.
import { basename, resolve } from "node:path";
import { openDb } from "./index.js";
import { toLocalDate, toLocalIso, addDays, parseLocal } from "../lib/time.js";
const TAG = "demo-activity";
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const file = arg("db") ?? process.env.DB_FILE ?? "data/pharmacy.sqlite";
const days = Math.max(1, Math.min(730, Number(arg("days") ?? 120) || 120));
const seed = Number(arg("seed") ?? 42) || 42;
if (/REAL_DATA/i.test(basename(file)) || /REAL_DATA/i.test(resolve(file))) {
    console.error(`refusing to write demo activity into ${file}: the name says it holds real data`);
    process.exit(1);
}
// deterministic PRNG (mulberry32) so a re-run with the same seed produces the same picture
let s = seed >>> 0;
const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
function weighted(entries) {
    const total = entries.reduce((n, [, w]) => n + w, 0);
    let r = rnd() * total;
    for (const [v, w] of entries)
        if ((r -= w) <= 0)
            return v;
    return entries[entries.length - 1][0];
}
/** Cumulative-weight sampler for large weighted lists. */
function sampler(values, weights) {
    const cum = [];
    let acc = 0;
    for (const w of weights)
        cum.push((acc += w));
    return () => {
        const r = rnd() * acc;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < r)
                lo = mid + 1;
            else
                hi = mid;
        }
        return values[lo];
    };
}
const gauss = (x, mu, sd) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
// hour-of-day weights: three shift peaks + a daytime floor + a quiet night
const HOUR_W = Array.from({ length: 24 }, (_, h) => 5 * gauss(h, 6, 0.9) + 3.2 * gauss(h, 12, 1.1) + 2.6 * gauss(h, 18, 1.1) + (h >= 8 && h <= 22 ? 0.35 : 0.08));
const hourOf = sampler(Array.from({ length: 24 }, (_, h) => h), HOUR_W);
function typeFor(hour) {
    if (hour >= 5 && hour <= 7)
        return weighted([["run_24h", 60], ["selected_times", 22], ["drip", 10], ["manual", 8]]);
    if (hour >= 11 && hour <= 13)
        return weighted([["midday", 50], ["selected_times", 28], ["manual", 12], ["drip", 10]]);
    if (hour >= 17 && hour <= 19)
        return weighted([["selected_times", 58], ["manual", 25], ["drip", 17]]);
    return weighted([["manual", 50], ["selected_times", 30], ["drip", 20]]);
}
const FIRST = ["أحمد", "محمد", "محمود", "مصطفى", "علي", "حسن", "إبراهيم", "يوسف", "عمر", "خالد", "سارة", "منى", "هدى", "آية", "فاطمة", "مريم", "نورا", "ريم"];
const LAST = ["فتحي", "كمال", "سالم", "حامد", "جمال", "فؤاد", "عبد الله", "رمضان", "شوقي", "منصور", "عادل", "سمير"];
const QTY_UNITS = [1, 1, 1, 1, 2, 2, 0.5, 3, 1, 4, 10, 0.25];
const db = openDb(file);
const now = new Date();
const today = toLocalDate(now);
const nowTs = toLocalIso(now);
const res = db.tx(() => {
    // ---- idempotency: drop previous demo rows (and the demo walk-in tickets they belonged to) ----
    const oldTickets = db.all(`SELECT DISTINCT t.id FROM walkin_tickets t JOIN dispenses d ON d.walkin_ticket_id = t.id
     WHERE d.notes = ? AND t.patient_ref LIKE 'DEMO-%'`, [TAG]).map((r) => r.id);
    const removed = db.run("DELETE FROM dispenses WHERE notes = ?", [TAG]).changes;
    for (const id of oldTickets)
        db.run("DELETE FROM walkin_tickets WHERE id = ? AND patient_ref LIKE 'DEMO-%'", [id]);
    const insDispense = db.raw.prepare(`INSERT INTO dispenses(at,location_id,patient_id,patient_name,order_id,walkin_ticket_id,item_id,batch_id,qty,type,user_id,run_id,notes)
     VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?)`);
    const insTicket = db.raw.prepare("INSERT INTO walkin_tickets(created_at,location_id,patient_ref,patient_name,user_id,dispensed_at) VALUES (?,?,?,?,?,?)");
    const insLine = db.raw.prepare(`INSERT INTO walkin_lines(ticket_id,line_no,item_id,unit,qty,to_dispense,to_print,dispensed_qty,created_at) VALUES (?,?,?,?,?,1,1,?,?)`);
    const locations = db.all(`SELECT l.id, l.name FROM locations l WHERE l.active = 1
       AND EXISTS (SELECT 1 FROM departments dep WHERE dep.location_id = l.id AND dep.active = 1) ORDER BY l.id`);
    const summary = [];
    let ticketNo = (db.get("SELECT COUNT(*) AS n FROM walkin_tickets WHERE patient_ref LIKE 'DEMO-%'")?.n ?? 0) + 1;
    for (const loc of locations) {
        const patients = db.all(`SELECT p.id, p.name FROM patients p JOIN departments dep ON dep.id = p.department_id
       WHERE dep.location_id = ? AND p.id LIKE '9000%' ORDER BY p.id`, [loc.id]);
        // one batch per item to point the rows at: real stock first, then the earliest expiry (FEFO-like), else TEMP
        const items = db.all(`SELECT b.item_id AS itemId, b.id AS batchId, i.unit, 1 - b.is_placeholder AS real FROM batches b JOIN items i ON i.id = b.item_id
       WHERE b.location_id = ? AND b.id = (SELECT b2.id FROM batches b2 WHERE b2.item_id = b.item_id AND b2.location_id = b.location_id
                                          ORDER BY b2.is_placeholder, IFNULL(b2.expiry_date, '9999-12-31'), b2.id LIMIT 1)
       ORDER BY b.item_id`, [loc.id]);
        if (!items.length) {
            summary.push({ location: loc.name, lines: 0, returns: 0, tickets: 0, skipped: "no batches" });
            continue;
        }
        const users = db.all("SELECT id, role FROM users WHERE active = 1 AND role <> 'viewer' AND (location_id = ? OR role = 'admin') ORDER BY id", [loc.id]);
        const userOf = users.length
            ? sampler(users.map((u) => u.id), users.map((u) => (u.role === "admin" ? 1 : 4)))
            : () => null;
        // long-tail popularity: random ranking (items with real, non-TEMP stock tend to rank higher so stock cover has
        // something to show), then Zipf-like weights 1/rank^1.15; each item gets a typical quantity per line
        const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        } return a; };
        const realPool = shuffle(items.filter((it) => it.real)), tempPool = shuffle(items.filter((it) => !it.real));
        const shuffled = [];
        while (realPool.length || tempPool.length)
            shuffled.push((realPool.length && (!tempPool.length || rnd() < 0.6) ? realPool : tempPool).pop());
        const itemOf = sampler(shuffled, shuffled.map((_, r) => 1 / Math.pow(r + 1, 1.15)));
        const unitQty = new Map(shuffled.map((it) => [it.itemId, pick(QTY_UNITS)]));
        const patientOf = patients.length ? sampler(patients, patients.map(() => 0.4 + rnd())) : null;
        const base = Math.min(90, 28 + patients.length * 6);
        let lines = 0, returns = 0, tickets = 0;
        const recent = [];
        for (let back = days - 1; back >= 0; back--) {
            const day = toLocalDate(addDays(parseLocal(today), -back));
            const wd = parseLocal(day).getDay();
            const weekend = wd === 5 || wd === 6 ? 0.6 : 1; // Friday / Saturday
            const trend = 0.85 + 0.3 * ((days - back) / days); // gentle growth over the period
            const n = Math.max(0, Math.round(base * weekend * trend * (0.8 + 0.4 * rnd())));
            const ts = (h) => `${day}T${String(h).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}`;
            for (let i = 0; i < n; i++) {
                const hour = hourOf();
                const at = ts(hour);
                if (at > nowTs)
                    continue; // nothing in the future
                const walkin = !patientOf || rnd() < 0.12;
                if (walkin) {
                    // one walk-in ticket with 1–4 lines dispensed together
                    const name = `مريض تجريبي ${pick(FIRST)} ${pick(LAST)}`;
                    const ref = `DEMO-W${String(ticketNo++).padStart(5, "0")}`;
                    const user = userOf();
                    const t = Number(insTicket.run(at, loc.id, ref, name, user, at).lastInsertRowid);
                    tickets++;
                    const count = weighted([[1, 40], [2, 30], [3, 20], [4, 10]]);
                    const used = new Set();
                    for (let ln = 1; ln <= count; ln++) {
                        const it = itemOf();
                        if (used.has(it.itemId))
                            continue;
                        used.add(it.itemId);
                        const qty = unitQty.get(it.itemId) * (rnd() < 0.7 ? 1 : 2);
                        insLine.run(t, ln, it.itemId, it.unit, qty, qty, at);
                        insDispense.run(at, loc.id, ref, name, t, it.itemId, it.batchId, qty, "walkin", user, `demo-w-${t}`, TAG);
                        lines++;
                    }
                    continue;
                }
                const p = patientOf();
                const it = itemOf();
                const type = typeFor(hour);
                const qty = unitQty.get(it.itemId) * weighted([[1, 60], [2, 25], [3, 10], [0.5, 5]]);
                const runId = type === "manual" ? `demo-m-${loc.id}-${day}-${i}` : `demo-${type}-${loc.id}-${day}-${hour}`;
                insDispense.run(at, loc.id, p.id, p.name, null, it.itemId, it.batchId, qty, type, userOf(), runId, TAG);
                lines++;
                recent.push({ at, patientId: p.id, patientName: p.name, itemId: it.itemId, batchId: it.batchId, qty });
            }
            // ~3–6 % of the day's inpatient lines come back as returns a few hours later
            const rate = 0.03 + 0.03 * rnd();
            const todays = recent.filter((r) => r.at.startsWith(day));
            for (const r of todays) {
                if (rnd() >= rate)
                    continue;
                const later = new Date(parseLocal(r.at).getTime() + (1 + rnd() * 10) * 3_600_000);
                const at = toLocalIso(later);
                if (at > nowTs)
                    continue;
                const qty = rnd() < 0.7 ? r.qty : Math.max(0.25, Math.round(r.qty * rnd() * 4) / 4);
                insDispense.run(at, loc.id, r.patientId, r.patientName, null, r.itemId, r.batchId, qty, "return", userOf(), `demo-r-${loc.id}-${at}`, TAG);
                returns++;
            }
            recent.length = 0;
        }
        summary.push({ location: loc.name, lines, returns, tickets });
    }
    return { removed, removedTickets: oldTickets.length, summary };
});
console.log(`dev activity (${days} days, seed ${seed}) → ${file}`);
console.log(`  removed previous demo rows: ${res.removed} dispenses, ${res.removedTickets} walk-in tickets`);
for (const r of res.summary)
    console.log(`  ${r.location}: ${r.skipped ? `skipped (${r.skipped})` : `${r.lines} lines, ${r.returns} returns, ${r.tickets} walk-in tickets`}`);
db.close();
