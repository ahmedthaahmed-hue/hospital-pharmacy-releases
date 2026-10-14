import { hashPassword } from "../auth/passwords.js";
import { BUILTIN_ROLES, levelFor } from "../core/permissions.js";
import { checkDigit } from "../core/gs1.js";
import { createRequest, issue } from "../modules/transfers/service.js";
import { nowIso, toLocalDate, toLocalIso, addDays, parseLocal } from "../lib/time.js";
/** Rows written by addDemoActivity carry this in dispenses.notes. */
export const DEMO_TAG = "demo-activity";
const TAG = DEMO_TAG;
export const DEMO_PASSWORD = "demo1234";
export const DEMO_USERS = [
    { username: "manager", name: "مدير الصيدلية (تجريبي)", role: "manager" },
    { username: "senior", name: "صيدلي أول (تجريبي)", role: "senior" },
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
    for (const u of DEMO_USERS) {
        const r = BUILTIN_ROLES.find((x) => x.key === u.role);
        const roleId = db.get("SELECT id FROM roles WHERE key = ?", [u.role])?.id ?? null;
        db.run(`INSERT INTO users(username,display_name,password_hash,role,role_id,location_id,must_change_password,created_at) VALUES (?,?,?,?,?,?,0,?)
            ON CONFLICT(username) DO NOTHING`, [u.username, u.name, hash, levelFor(r.permissions), roleId, home, nowIso()]);
    }
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
    const safety = addDemoSafety(db);
    const barcodes = addDemoBarcodes(db);
    const supply = addDemoSupply(db, now);
    const records = addDemoRecords(db, now);
    const badges = addDemoBadges(db);
    const clinical = addDemoClinical(db);
    db.run("INSERT INTO settings(key,value) VALUES ('system.demo','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    return { shiftedDays, restartedOrders, stockedBatches, sharedTemplates, users: DEMO_USERS.map((u) => u.username), activity: activity.summary, safety, barcodes, supply, records, badges, clinical };
}
/** Demo interaction rules (examples to show the checks; a real hospital's pharmacists write their own). */
const DEMO_RULES = [
    ["إينوكسابارين", "ديكلوفيناك", "major", "Bleeding risk: an anticoagulant with an NSAID", "Prefer paracetamol for pain; if both are needed, watch for bleeding"],
    ["ديجوكسين", "كلاريثروميسين", "major", "Clarithromycin raises digoxin levels (toxicity)", "Choose another antibiotic or check the digoxin level"],
    ["ترامادول", "مورفين", "major", "Two opioids: breathing and sedation risk", "Confirm with the doctor that both are meant"],
    ["كلوبيدوغريل", "إينوكسابارين", "moderate", "More bleeding with an antiplatelet and an anticoagulant", "Watch for bleeding"],
    ["ميثوتريكسات", "ديكلوفيناك", "major", "NSAIDs reduce methotrexate clearance (toxicity)", "Avoid together, or check with the doctor"],
    ["كلوريد البوتاسيوم", "كابتوبريل", "minor", "ACE inhibitor with potassium: check potassium", null],
];
/**
 * Patient safety on the demo (release 1.4): the synthetic patients get a sex, a weight and height, and a mix of allergy
 * states (most "no known allergies", some not asked yet, a few with allergies — one against a medicine they are on, so
 * the check shows when that order is changed); the items the old system classed "عالية الخطورة" (high risk) are
 * high-alert; paracetamol gets dose limits; and a handful of example interaction rules. Deterministic; runs once.
 */
export function addDemoSafety(db) {
    const at = nowIso();
    const patients = db.all("SELECT id, dob, name FROM patients WHERE id LIKE '9000%' ORDER BY id");
    // the made-up names' first names (after "مريض تجريبي") tell the sex
    const FEMALE = ["آية", "هدى", "ريم", "نور", "فاطمة", "سارة", "سلمى", "مريم"];
    const female = (name) => FEMALE.includes(name.replace("مريض تجريبي", "").trim().split(/\s+/)[0] ?? "");
    let allergic = 0;
    patients.forEach((p, i) => {
        const age = p.dob ? Math.max(0, new Date(at).getFullYear() - Number(p.dob.slice(0, 4))) : 40;
        const kg = age < 2 ? 4 + age * 5 : age < 14 ? 10 + age * 3 : 55 + ((i * 7) % 40);
        const cm = age < 2 ? 55 + age * 20 : age < 14 ? 80 + age * 6 : 155 + ((i * 5) % 30);
        const status = i % 9 === 4 ? "unknown" : "nka";
        db.run("UPDATE patients SET sex = ?, weight_kg = ?, weight_at = ?, height_cm = ?, height_at = ?, allergy_status = ? WHERE id = ?", [female(p.name) ? "F" : "M", kg, at, cm, at, status, p.id]);
    });
    // a few allergies: against the class of antibiotics, and against an ingredient one of their running orders contains
    const add = (patientId, kind, value, reaction, severity) => {
        if (db.get("SELECT 1 FROM patient_allergies WHERE patient_id = ? AND value = ?", [patientId, value]))
            return;
        db.run("INSERT INTO patient_allergies(patient_id, kind, value, reaction, severity, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)", [patientId, kind, value, reaction, severity, at, at]);
        db.run("UPDATE patients SET allergy_status = 'has' WHERE id = ?", [patientId]);
        allergic++;
    };
    const onOrder = db.all(`SELECT o.patient_id, i.active_ingredient ai FROM medication_orders o JOIN items i ON i.id = o.item_id
     WHERE o.patient_id LIKE '9000%' AND o.status = 'active' AND IFNULL(TRIM(i.active_ingredient),'') <> '' AND i.active_ingredient NOT LIKE '%+%'
     GROUP BY o.patient_id ORDER BY o.patient_id LIMIT 2`);
    for (const o of onOrder)
        add(o.patient_id, "ingredient", o.ai, "طفح جلدي", "moderate");
    const others = patients.filter((p) => !onOrder.some((o) => o.patient_id === p.id));
    if (others[3])
        add(others[3].id, "class", "مضاد حيوي", "حساسية شديدة", "severe");
    if (others[11])
        add(others[11].id, "other", "بنسلين", "ضيق تنفس", "severe");
    if (others[17])
        add(others[17].id, "ingredient", "ديكلوفيناك", "تورم", "mild");
    // high-alert: the old system's own "high risk" class
    const highAlert = db.run("UPDATE items SET high_alert = 1 WHERE TRIM(class) = 'عالية الخطورة' AND high_alert = 0").changes;
    // dose limits for paracetamol tablets and infusion (the strength is in mg)
    db.run(`UPDATE items SET dose_unit = 'mg', max_single_dose = 1000, max_daily_dose = 4000, max_single_per_kg = 15, max_daily_per_kg = 60
          WHERE active_ingredient = 'باراسيتامول' AND strength IN ('500', '1000') AND dose_unit IS NULL`);
    let rules = 0;
    for (const [a, b, severity, message, advice] of DEMO_RULES) {
        if (db.get("SELECT 1 FROM interaction_rules WHERE a_value = ? AND b_value = ?", [a, b]))
            continue;
        db.run(`INSERT INTO interaction_rules(a_kind, a_value, b_kind, b_value, severity, message, advice, active, created_at, updated_at)
            VALUES ('ingredient', ?, 'ingredient', ?, ?, ?, ?, 1, ?, ?)`, [a, b, severity, `${message} (demo example)`, advice ?? null, at, at]);
        rules++;
    }
    return { patients: patients.length, allergic, highAlert, rules };
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
/** The made-up product code (GTIN-14) the demo gives an item: Egypt's prefix 622, a made-up maker 9999, the item number. */
export function demoGtin(itemNo) {
    const body = `062299${String(itemNo % 10_000_000).padStart(7, "0")}`;
    return body + checkDigit(body);
}
/**
 * Barcodes and recalls on the demo (release 1.5): every item with stock gets a made-up product code (so its packs can be
 * scanned: print one from Admin → Labels or type it), one batch is quarantined at the busiest pharmacy, and the most
 * dispensed lot there is recalled, so "Who received it" has patients to show.
 */
export function addDemoBarcodes(db) {
    const at = nowIso();
    const items = db.all("SELECT DISTINCT i.id, i.item_no FROM items i JOIN batches b ON b.item_id = i.id AND b.is_placeholder = 0 WHERE i.active = 1");
    let codes = 0;
    for (const i of items)
        codes += db.run("INSERT OR IGNORE INTO item_barcodes(code, item_id, created_at) VALUES (?,?,?)", [demoGtin(i.item_no), i.id, at]).changes;
    const home = busiestPharmacy(db);
    let holds = 0;
    if (home && !db.get("SELECT 1 FROM batch_holds")) {
        const recall = db.get(`SELECT b.item_id, b.batch_no FROM dispenses x JOIN batches b ON b.id = x.batch_id
       WHERE b.location_id = ? AND b.is_placeholder = 0 AND b.qty > 0 GROUP BY b.id ORDER BY COUNT(*) DESC LIMIT 1`, [home]);
        if (recall)
            holds += db.run(`INSERT INTO batch_holds(item_id, batch_no, location_id, kind, reason, reference, active, created_at) VALUES (?,?,NULL,'recall',?,?,1,?)`, [recall.item_id, recall.batch_no, "Demo recall: possible contamination (made up)", "Demo circular 1/2026", at]).changes;
        const quarantine = db.get(`SELECT item_id, batch_no FROM batches WHERE location_id = ? AND is_placeholder = 0 AND qty > 0 AND item_id <> ? ORDER BY qty DESC LIMIT 1`, [home, recall?.item_id ?? ""]);
        if (quarantine)
            holds += db.run(`INSERT INTO batch_holds(item_id, batch_no, location_id, kind, reason, active, created_at) VALUES (?,?,?,'quarantine',?,1,?)`, [quarantine.item_id, quarantine.batch_no, home, "Demo: packs found damaged on the shelf", at]).changes;
    }
    return { codes, holds };
}
/**
 * Supply on the demo (release 1.6): the main store (a pharmacy named like "Main Storage") holds stock of the items the
 * busiest pharmacy uses, with made-up prices; two made-up suppliers and a purchase order sent to one; minimum and
 * maximum levels at the busiest pharmacy (a few below their minimum, so a request is suggested); one request from it to
 * the main store waiting to be issued, and one transfer on its way to be received.
 */
export function addDemoSupply(db, now = new Date()) {
    const home = busiestPharmacy(db);
    const store = db.get("SELECT id FROM locations WHERE active = 1 AND (name LIKE '%main%' OR name LIKE '%store%' OR name LIKE '%مخزن%') ORDER BY id LIMIT 1")?.id;
    if (!home || !store || store === home || db.get("SELECT 1 FROM suppliers"))
        return { storeBatches: 0, transfers: 0 };
    const today = toLocalDate(now), at = toLocalIso(now);
    const items = db.all(`SELECT b.item_id, i.item_no, SUM(b.qty) qty FROM batches b JOIN items i ON i.id = b.item_id
     WHERE b.location_id = ? AND b.is_placeholder = 0 AND b.qty > 0 AND i.active = 1 GROUP BY b.item_id ORDER BY b.item_id`, [home]);
    let storeBatches = 0;
    db.tx(() => {
        items.forEach((it, i) => {
            const price = Math.round((2 + ((it.item_no * 37) % 180)) * 100) / 100 / (i % 3 === 0 ? 1 : 4); // made-up EGP prices
            db.run("UPDATE items SET unit_price = ? WHERE id = ?", [price, it.item_id]);
            db.run("UPDATE batches SET unit_cost = ? WHERE item_id = ? AND is_placeholder = 0 AND unit_cost IS NULL", [price, it.item_id]);
            const expiry = toLocalDate(addDays(parseLocal(today), 240 + (i % 9) * 40));
            const b = db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,unit_cost,created_at) VALUES (?,?,?,?,?,0,?,?)", [it.item_id, store, `MS-${String(i + 1).padStart(4, "0")}`, expiry, 500 + ((i * 131) % 1500), price, at]).lastId;
            db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,note) SELECT ?, id, 'receive', qty, 'demo stock (main store)' FROM batches WHERE id = ?", [at, b]);
            storeBatches++;
            // levels at the busiest pharmacy: every 4th item; a few set above what it holds
            if (i % 4 === 0) {
                const min = i % 12 === 0 ? Math.ceil(it.qty * 1.5) : Math.max(5, Math.floor(it.qty / 4));
                db.run("INSERT OR IGNORE INTO stock_levels(item_id, location_id, min_qty, max_qty, updated_at) VALUES (?,?,?,?,?)", [it.item_id, home, min, min * 3, at]);
            }
        });
        for (const [name, phone] of [["شركة النيل للأدوية (تجريبي)", "0223456789"], ["المتحدة للتوزيع الطبي (تجريبي)", "0233334444"]])
            db.run("INSERT INTO suppliers(name, phone, active, created_at) VALUES (?,?,1,?)", [name, phone, at]);
        const sup = db.get("SELECT id FROM suppliers ORDER BY id LIMIT 1").id;
        const po = db.run("INSERT INTO purchase_orders(supplier_id, location_id, status, reference, created_at, sent_at) VALUES (?,?,'sent','DEMO-PO-1',?,?)", [sup, store, at, at]).lastId;
        for (const it of items.slice(0, 4))
            db.run("INSERT INTO purchase_order_lines(po_id, item_id, qty, unit_price) SELECT ?, id, 200, unit_price FROM items WHERE id = ?", [po, it.item_id]);
    });
    // a request waiting at the main store, and a transfer on its way to the busiest pharmacy
    const pick = (from, n) => items.slice(from, from + n).map((it) => ({ itemId: it.item_id, qty: 20 }));
    createRequest(db, { from: store, to: home, lines: pick(0, 3), note: "Demo: weekly top-up", userId: null });
    const sent = createRequest(db, { from: store, to: home, lines: pick(3, 2), note: "Demo: urgent", userId: null });
    issue(db, sent, null, null);
    return { storeBatches, transfers: 2 };
}
/**
 * Records on the demo (release 1.7): the items the old system classed "اصناف جدول" (scheduled) are controlled (the
 * benzodiazepines and pregabalin psychotropic, the rest narcotic), with a month of doses to patients in their register,
 * each counted with a witness yesterday (one with a broken ampoule);
 * two fridges at the busiest pharmacy read over the last 30 days (a few readings missed, one out of range with what was
 * done); an emergency cart checked 25 days ago and a ward-stock cupboard never checked (due); and a dozen pharmacist
 * interventions with their outcomes. Deterministic; runs once.
 */
export function addDemoRecords(db, now = new Date()) {
    const home = busiestPharmacy(db);
    if (!home || db.get("SELECT 1 FROM fridges"))
        return { controlled: 0, readings: 0, interventions: 0 };
    let s = 1707;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const at = (daysBack, h, m = 0) => { const d = addDays(now, -daysBack); d.setHours(h, m, 0, 0); return toLocalIso(d); };
    const users = db.all("SELECT id FROM users WHERE active = 1 AND username IN ('manager','senior','pharm') ORDER BY id").map((u) => u.id);
    const [u1, u2] = [users[0] ?? null, users[1] ?? users[0] ?? null];
    let readings = 0;
    const out = db.tx(() => {
        const psycho = ["ميدازولام", "ديازيبام", "كلونازيبام", "لورازيبام", "فينوباربيتال", "دورميكم", "كالميام", "ليريكا", "بريجابالين"]
            .map((n) => `(name || ' ' || IFNULL(selection_name, '')) LIKE '%${n}%'`).join(" OR ");
        const controlled = db.run(`UPDATE items SET controlled = CASE WHEN ${psycho} THEN 'psychotropic' ELSE 'narcotic' END
      WHERE TRIM(class) = 'اصناف جدول' AND controlled IS NULL`).changes;
        // their register: the demo stock arrived a month ago, and patients got doses since (each with its movement)
        const pats0 = db.all("SELECT p.id, p.name FROM patients p JOIN departments d ON d.id = p.department_id WHERE d.location_id = ? AND p.active = 1 ORDER BY p.id LIMIT 8", [home]);
        const cdBatches = db.all(`SELECT b.id, b.item_id, b.qty FROM batches b JOIN items i ON i.id = b.item_id WHERE i.controlled IS NOT NULL AND b.location_id = ? AND b.is_placeholder = 0 AND b.qty > 0 ORDER BY b.id`, [home]);
        for (const b of cdBatches) {
            db.run("UPDATE stock_movements SET at = ? WHERE batch_id = ? AND kind = 'receive' AND note = 'demo stock'", [at(30, 9, 15), b.id]);
            let left = b.qty;
            for (let n = 0; n < 8 && pats0.length; n++) {
                const q = 1 + Math.floor(rnd() * 2);
                if (left - q < 5)
                    break;
                const pt = pats0[Math.floor(rnd() * pats0.length)];
                const when = at(20 - n * 2 - Math.floor(rnd() * 2), 6 + Math.floor(rnd() * 14), Math.floor(rnd() * 60));
                const dId = db.run(`INSERT INTO dispenses(at,location_id,patient_id,patient_name,item_id,batch_id,qty,type,user_id,notes) VALUES (?,?,?,?,?,?,?,'manual',?,'demo (records)')`, [when, home, pt.id, pt.name, b.item_id, b.id, q, u1]).lastId;
                db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,'dispense',?,?,?)", [when, b.id, -q, dId, u1]);
                db.run("UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?", [q, b.id]);
                left -= q;
            }
        }
        const cds = db.all(`SELECT i.id, COALESCE(SUM(b.qty),0) q FROM items i JOIN batches b ON b.item_id = i.id AND b.location_id = ? AND b.is_placeholder = 0
       WHERE i.controlled IS NOT NULL GROUP BY i.id ORDER BY i.id`, [home]);
        cds.forEach((c, i) => {
            const broken = i === 0 && c.q >= 1;
            db.run("INSERT INTO cd_checks(item_id, location_id, at, expected, counted, note, user_id, witness_id) VALUES (?,?,?,?,?,?,?,?)", [c.id, home, at(1, 21, 30), c.q, broken ? c.q - 1 : c.q, broken ? "أمبول مكسور — محضر رقم 14" : null, u1, u2]);
        });
        // fridges: twice / three times a day, mostly 3.5–6.5 °C
        const fridge = (name, perDay) => db.run("INSERT INTO fridges(location_id, name, min_c, max_c, readings_per_day, active, created_at) VALUES (?,?,2,8,?,1,?)", [home, name, perDay, at(40, 8)]).lastId;
        const fs = [fridge("ثلاجة الأنسولين", 2), fridge("ثلاجة اللقاحات", 3)];
        const hours = [[8], [8, 20], [8, 14, 20]];
        for (let day = 29; day >= 0; day--) {
            fs.forEach((f, fi) => {
                for (const h of hours[fi === 0 ? 1 : 2]) {
                    if (day === 0 && h > now.getHours())
                        continue;
                    if (rnd() < 0.04)
                        continue; // a reading missed now and then
                    let t = Math.round((3.5 + rnd() * 3) * 10) / 10, action = null, mx = null;
                    if (fi === 0 && day === 12 && h === 8) {
                        t = 9.4;
                        mx = 10.1;
                        action = "الباب كان مفتوحاً طوال الليل: أُغلق، ونُقل الأنسولين لثلاجة اللقاحات، وأُبلغت الصيانة";
                    }
                    db.run("INSERT INTO fridge_readings(fridge_id, at, temp_c, min_c, max_c, out_of_range, action, user_id) VALUES (?,?,?,?,?,?,?,?)", [f, at(day, h, Math.floor(rnd() * 20)), t, mx != null ? 3.1 : null, mx, action ? 1 : 0, action, u1]);
                    readings++;
                }
            });
        }
        // an emergency cart (checked 25 days ago) and a ward-stock cupboard (never checked)
        const dept = db.get("SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1", [home])?.id ?? null;
        const stocked = db.all(`SELECT i.id FROM items i JOIN batches b ON b.item_id = i.id AND b.location_id = ? AND b.is_placeholder = 0 AND b.qty > 0
       WHERE i.active = 1 GROUP BY i.id ORDER BY (i.name LIKE '%أدرينالين%' OR i.name LIKE '%اتروبين%' OR i.name LIKE '%أتروبين%' OR i.name LIKE '%أميودارون%') DESC, SUM(b.qty) DESC LIMIT 10`, [home]);
        const cart = (name, kind, items) => {
            const id = db.run("INSERT INTO carts(location_id, department_id, name, kind, check_every_days, active, created_at) VALUES (?,?,?,?,30,1,?)", [home, dept, name, kind, at(60, 9)]).lastId;
            items.forEach((it, i) => db.run("INSERT INTO cart_items(cart_id, item_id, par_qty) VALUES (?,?,?)", [id, it.id, [2, 5, 10][i % 3]]));
            return id;
        };
        const c1 = cart("عربة الطوارئ — الاستقبال", "emergency", stocked.slice(0, 6));
        cart("مخزون القسم — الباطنة", "ward_stock", stocked.slice(4, 10));
        const k = db.run("INSERT INTO cart_checks(cart_id, at, seal_no, status, note, user_id) VALUES (?,?,?,?,?,?)", [c1, at(25, 10), "S-20418", "ok", null, u1]).lastId;
        stocked.slice(0, 6).forEach((it, i) => db.run("INSERT INTO cart_check_lines(check_id, item_id, present, nearest_expiry, restocked) VALUES (?,?,?,?,0)", [k, it.id, [2, 5, 10][i % 3], toLocalDate(addDays(now, 40 + i * 60))]));
        // interventions
        const pats = db.all("SELECT p.id FROM patients p JOIN departments d ON d.id = p.department_id WHERE d.location_id = ? AND p.active = 1 ORDER BY p.id LIMIT 12", [home]);
        const anItem = (i) => stocked[i % Math.max(1, stocked.length)]?.id ?? null;
        const cases = [
            ["renal", "تصفية الكرياتينين 28 مل/د: الجرعة أعلى من المناسب", "تقليل الجرعة إلى النصف", "accepted", "major"],
            ["interaction", "تداخل بين مضاد التجلط ومسكن غير ستيرويدي", "استبدال المسكن بباراسيتامول", "accepted", "major"],
            ["dose", "الجرعة مكتوبة مرتين يومياً والمعتاد مرة", "مرة واحدة يومياً", "modified", "moderate"],
            ["duplicate", "مضادان حيويان من نفس المجموعة", "إيقاف أحدهما", "accepted", "moderate"],
            ["route", "الدواء الفموي مطلوب والمريض لا يبلع", "تحويله لشراب أو وريد", "accepted", "minor"],
            ["iv_compatibility", "لا يُعطى مع المحلول المكتوب في نفس الخط", "خط منفصل أو محلول ملحي", "accepted", "moderate"],
            ["allergy", "المريض لديه حساسية مسجلة لنفس المجموعة", "بديل من مجموعة أخرى", "accepted", "major"],
            ["indication", "لا يوجد سبب مكتوب لمضاد الحموضة", "إيقافه عند الخروج", "rejected", "minor"],
            ["monitoring", "يحتاج مستوى الدواء في الدم بعد الجرعة الرابعة", "طلب المستوى", "accepted", "moderate"],
            ["dose", "جرعة الأطفال محسوبة على وزن قديم", "إعادة الحساب على الوزن الحالي", "modified", "major"],
            ["other", "مدة العلاج غير مكتوبة", "تحديد المدة بسبعة أيام", "pending", "minor"],
            ["interaction", "دواءان يطيلان QT معاً", "رسم قلب ومتابعة", "pending", "moderate"],
        ];
        cases.forEach(([kind, problem, rec, outcome, sig], i) => {
            const when = at(28 - i * 2, 10 + (i % 6));
            db.run(`INSERT INTO interventions(at, location_id, patient_id, item_id, kind, problem, recommendation, prescriber, outcome, significance, user_id, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [when, home, pats[i % Math.max(1, pats.length)]?.id ?? null, anItem(i), kind, problem, rec, ["د. أحمد سامي", "د. منى عادل", "د. كريم فؤاد"][i % 3], outcome, sig, u1, when]);
        });
        return { controlled, readings, interventions: cases.length };
    });
    return out;
}
/** Badges and PINs on the demo (release 1.8): each demo account gets a badge (printable from Admin → Users) and the PIN 1234. */
export const DEMO_PIN = "1234";
export function addDemoBadges(db) {
    const pin = hashPassword(DEMO_PIN);
    let n = 0;
    DEMO_USERS.forEach((u, i) => {
        n += db.run("UPDATE users SET badge_code = ?, pin_hash = ? WHERE username = ? AND badge_code IS NULL", [`HPDE${String(i + 1).padStart(10, "0")}`, pin, u.username]).changes;
    });
    return n;
}
/**
 * Clinical extras on the demo (release 1.9): the latest few orders at the busiest pharmacy wait for a second
 * pharmacist's check (Clinical → Verify orders); items get a VEN class — the old system's high-risk and scheduled items
 * vital, vitamins and supplements non-essential, the rest essential.
 */
export function addDemoClinical(db) {
    const home = busiestPharmacy(db);
    if (!home)
        return { unverified: 0, ven: 0 };
    db.run("UPDATE medication_orders SET verified_at = COALESCE(verified_at, created_at)");
    const unverified = db.run(`UPDATE medication_orders SET verified_at = NULL, verified_by = NULL WHERE id IN (
      SELECT o.id FROM medication_orders o JOIN patients p ON p.id = o.patient_id JOIN departments d ON d.id = p.department_id
      WHERE d.location_id = ? AND o.status = 'active' AND p.active = 1 ORDER BY o.created_at DESC, o.id DESC LIMIT 4)`, [home]).changes;
    const ven = db.run(`UPDATE items SET ven = CASE
      WHEN TRIM(class) IN ('عالية الخطورة', 'اصناف جدول') OR high_alert = 1 THEN 'V'
      WHEN name LIKE '%فيتامين%' OR name LIKE '%مكمل%' OR name LIKE '%فوار%' THEN 'N'
      ELSE 'E' END WHERE ven IS NULL AND active = 1`).changes;
    return { unverified, ven };
}
