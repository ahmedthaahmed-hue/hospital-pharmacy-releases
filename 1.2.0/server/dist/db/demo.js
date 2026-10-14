import { hashPassword } from "../auth/passwords.js";
import { nowIso, toLocalDate, toLocalIso, addDays, parseLocal } from "../lib/time.js";
/** Rows written by addDemoActivity carry this in dispenses.notes. */
export const DEMO_TAG = "demo-activity";
const TAG = DEMO_TAG;
export const DEMO_PASSWORD = "demo1234";
export const DEMO_USERS = [
    { username: "pharm", name: "صيدلي (تجريبي)", role: "pharmacist" },
    { username: "view", name: "مراجع (تجريبي)", role: "viewer" },
];
/** True on a server (or its pharmacy PCs) that runs the demo hospital. */
export function isDemo(db) {
    try {
        return db().get("SELECT value FROM settings WHERE key = 'system.demo'")?.value === "1";
    }
    catch {
        return false;
    } // no database open yet: certainly not a demo
}
// dates written as 'YYYY-MM-DDTHH:MM:SS' / 'YYYY-MM-DD' (other forms, e.g. the import's own UTC stamps, are left alone)
const DATETIMES = [["patients", "created_at"], ["patients", "updated_at"], ["batches", "created_at"],
    ["medication_orders", "created_at"], ["medication_orders", "updated_at"], ["medication_orders", "next_dispense_at"],
    ["dispenses", "at"], ["walkin_tickets", "created_at"], ["walkin_tickets", "dispensed_at"], ["walkin_lines", "created_at"],
    ["chat_messages", "created_at"]];
const DATES = [["medication_orders", "start_date"], ["batches", "expiry_date"]];
/**
 * Move every date of the demo data by whole days so that its last dispensing day becomes yesterday: orders are running,
 * today's doses are still to be dispensed. Batches without a real expiry (9999/2099 placeholders) keep theirs.
 * Returns the number of days moved.
 */
export function bringDemoToToday(db, now = new Date()) {
    const last = db.get("SELECT MAX(substr(at, 1, 10)) AS d FROM dispenses WHERE notes IS NOT ?", [TAG])?.d;
    if (!last)
        return 0;
    const shift = Math.round((parseLocal(toLocalDate(addDays(now, -1))).getTime() - parseLocal(last).getTime()) / 86_400_000);
    if (!shift)
        return 0;
    const by = `${shift >= 0 ? "+" : ""}${shift} days`;
    db.tx(() => {
        for (const [t, c] of DATETIMES)
            db.run(`UPDATE ${t} SET ${c} = strftime('%Y-%m-%dT%H:%M:%S', ${c}, ?) WHERE ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`, [by]);
        for (const [t, c] of DATES)
            db.run(`UPDATE ${t} SET ${c} = date(${c}, ?) WHERE ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ${c} < '2090-01-01'`, [by]);
    });
    return shift;
}
/**
 * Orders that had ended by the day the demo was made are started again a few days ago (each by its own number of
 * days, within its duration), so every patient has treatment running and doses due today.
 */
export function restartEndedOrders(db, now = new Date()) {
    const today = toLocalDate(now);
    return db.run(`UPDATE medication_orders SET start_date = date(?, '-' || (id % CAST(duration_days AS INTEGER)) || ' days')
     WHERE status = 'active' AND CAST(duration_days AS INTEGER) > 0 AND date(start_date, '+' || CAST(duration_days AS INTEGER) || ' days') <= ?`, [today, today]).changes;
}
/** The pharmacy with the most active patients: where the demo staff work. */
const busiestPharmacy = (db) => db.get(`SELECT l.id FROM locations l LEFT JOIN departments d ON d.location_id = l.id LEFT JOIN patients p ON p.department_id = d.id AND p.active = 1
   WHERE l.active = 1 GROUP BY l.id ORDER BY COUNT(p.id) DESC, l.id LIMIT 1`)?.id ?? null;
/**
 * The demo staff accounts (kept as they are when the name is taken, e.g. by the admin), working in the busiest
 * pharmacy; an admin without a home pharmacy opens there too.
 */
export function addDemoUsers(db) {
    const home = busiestPharmacy(db);
    const hash = hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS)
        db.run(`INSERT INTO users(username,display_name,password_hash,role,location_id,must_change_password,created_at) VALUES (?,?,?,?,?,0,?)
            ON CONFLICT(username) DO NOTHING`, [u.username, u.name, hash, u.role, home, nowIso()]);
    if (home)
        db.run("UPDATE users SET location_id = ? WHERE role = 'admin' AND location_id IS NULL", [home]);
}
/**
 * Real (non-TEMP) stock in every pharmacy that has patients, for the items its orders and the templates use and that it
 * has none of: received today as batch DEMO-<n>, with a spread of quantities and expiry dates so the stock screens
 * have something to show (a few low, a few expiring within weeks, one already expired). Written like a receipt: each
 * batch gets its 'receive' movement. Returns the number of batches.
 */
export function stockDemoPharmacies(db, now = new Date()) {
    const today = toLocalDate(now), at = toLocalIso(now);
    const pharmacies = db.all(`SELECT DISTINCT d.location_id AS id FROM patients p JOIN departments d ON d.id = p.department_id WHERE p.active = 1 AND d.location_id IS NOT NULL`);
    let n = 0;
    db.tx(() => {
        for (const { id: loc } of pharmacies) {
            const items = db.all(`SELECT DISTINCT item_id AS itemId FROM (
           SELECT o.item_id FROM medication_orders o JOIN patients p ON p.id = o.patient_id JOIN departments d ON d.id = p.department_id
            WHERE d.location_id = ? AND o.status = 'active'
           UNION SELECT item_id FROM rx_template_lines UNION SELECT item_id FROM order_template_lines)
         WHERE item_id NOT IN (SELECT item_id FROM batches WHERE location_id = ? AND is_placeholder = 0 AND qty > 0)
           AND item_id IN (SELECT id FROM items WHERE active = 1)
         ORDER BY item_id`, [loc, loc]);
            items.forEach(({ itemId }, i) => {
                const k = (i * 7919 + loc * 104729) % 100; // a fixed spread, the same on every install
                const qty = k < 8 ? 2 + (k % 6) : 20 + ((k * 37) % 380); // ~8 % low
                const days = k === 50 ? -10 : k % 10 === 3 ? 10 + k : 180 + k * 6; // one expired, ~10 % within weeks
                const expiry = toLocalDate(addDays(parseLocal(today), days));
                const b = db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,0,?)", [itemId, loc, `DEMO-${loc}${String(i + 1).padStart(3, "0")}`, expiry, qty, at]).lastId;
                db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,note) VALUES (?,?,'receive',?,'demo stock')", [at, b, qty]);
                n++;
            });
        }
    });
    return n;
}
/** Template names in the demo data that were the old system's tests, not real templates. */
const TEST_NAMES = new Set(["6", "99", "101", "basic", "aa", "aaa", "sss", "ااا", "delete", "تجربة"]);
/**
 * The demo's Rx and order templates all belong to one pharmacy: every other pharmacy with patients and none of its own
 * gets a copy of the real-looking ones (active, two lines or more), so walk-ins and orders can be tried anywhere.
 */
export function shareDemoTemplates(db) {
    const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => c !== "id" && c !== "template_id").join(", ");
    const pharmacies = db.all(`SELECT DISTINCT d.location_id AS id FROM patients p JOIN departments d ON d.id = p.department_id WHERE p.active = 1 AND d.location_id IS NOT NULL`);
    let n = 0;
    db.tx(() => {
        for (const [head, lines] of [["rx_templates", "rx_template_lines"], ["order_templates", "order_template_lines"]]) {
            const keep = db.all(`SELECT t.id, t.name FROM ${head} t WHERE t.active = 1 AND (SELECT COUNT(*) FROM ${lines} l WHERE l.template_id = t.id) >= 2 ORDER BY t.id`)
                .filter((t) => !TEST_NAMES.has(t.name.trim().toLowerCase()));
            const c = cols(lines);
            for (const { id: loc } of pharmacies) {
                if (db.get(`SELECT 1 FROM ${head} WHERE location_id = ? AND active = 1`, [loc]))
                    continue;
                for (const t of keep) {
                    const copy = db.run(`INSERT INTO ${head}(name, location_id, active) VALUES (?, ?, 1)`, [t.name, loc]).lastId;
                    db.run(`INSERT INTO ${lines}(template_id, ${c}) SELECT ?, ${c} FROM ${lines} WHERE template_id = ? ORDER BY id`, [copy, t.id]);
                    n++;
                }
            }
        }
        // the test templates are not offered anywhere
        for (const head of ["rx_templates", "order_templates"])
            for (const name of TEST_NAMES)
                db.run(`UPDATE ${head} SET active = 0 WHERE lower(trim(name)) = ?`, [name]);
    });
    return n;
}
/** Turn the demo hospital into a ready-to-try system (after importing the demo data into an empty database). */
export function prepareDemo(db, now = new Date()) {
    const shiftedDays = bringDemoToToday(db, now);
    const restartedOrders = restartEndedOrders(db, now);
    addDemoUsers(db);
    const stockedBatches = stockDemoPharmacies(db, now);
    const sharedTemplates = shareDemoTemplates(db);
    const activity = addDemoActivity(db, { days: 90, now });
    db.run("INSERT INTO settings(key,value) VALUES ('system.demo','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    return { shiftedDays, restartedOrders, stockedBatches, sharedTemplates, users: DEMO_USERS.map((u) => u.username), activity: activity.summary };
}
/**
 * Realistic dispensing activity over the last `days` days for the synthetic patients (IDs 9000…) of every active
 * pharmacy with departments, and the items that have batches there: shift peaks around 06:00 / 12:00 / 18:00, a weekend
 * dip (Fri/Sat), a long-tail item popularity (so ABC classes mean something), ~3–6 % returns and walk-in tickets. Every
 * row is tagged notes = DEMO_TAG; running it again first deletes the previous rows. It never changes batches.qty or
 * stock_movements. Deterministic for a seed.
 */
export function addDemoActivity(db, { days = 120, seed = 42, now = new Date() } = {}) {
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
    const today = toLocalDate(now);
    const nowTs = toLocalIso(now);
    return db.tx(() => {
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
}
