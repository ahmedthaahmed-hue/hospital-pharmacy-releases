import { openDb } from "../db/index.js";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/passwords.js";
export const T0 = "2026-01-01T00:00:00";
/** Tables whose content a failed request must leave untouched. */
const TABLES = ["patients", "medication_orders", "batches", "stock_movements", "dispenses", "dispensed_slots", "dispense_runs", "walkin_tickets",
    "walkin_lines", "operations", "operation_kits", "operation_kit_lines", "operation_kit_exclusions", "rx_templates", "rx_template_lines",
    "order_templates", "order_template_lines", "items", "order_edits_after_dispense", "chat_messages"];
export async function world() {
    const db = openDb(":memory:");
    db.run("INSERT INTO locations(id,name) VALUES (1,'ICU'),(2,'EMR')");
    db.run("INSERT INTO departments(id,name,location_id) VALUES (1,'انتظار الطوارئ',2),(2,'كشف الطوارئ',2),(4,'جراحة',1)");
    db.run(`INSERT INTO items(id,item_no,name,unit) VALUES ('A1',1,'كونكور بلس','قرص'),('A2',2,'كاتيفاروكس','قرص'),('A3',3,'زيروفازيت','قرص'),
    ('NS',4,'محلول ملح','كيس'),('TMP',5,'صنف بدون رصيد','أمبول')`);
    const batch = (item, loc, no, exp, qty, ph = 0) => {
        const id = db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,?,?)", [item, loc, no, exp, qty, ph, T0]).lastId;
        db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,note) VALUES (?,?,'import',?,'opening')", [T0, id, qty]);
    };
    batch("A1", 2, "A1-EARLY", "2027-01-31", 7);
    batch("A1", 2, "A1-LATE", "2029-01-31", 300);
    batch("A1", 2, "A1-OLD", "2020-01-01", 50);
    batch("A2", 2, "A2-1", "2028-01-01", 200);
    batch("A3", 2, "A3-1", "2028-06-30", 120);
    batch("NS", 2, "NS-1", "2028-01-01", 40);
    batch("A1", 1, "A1-ICU", "2029-01-31", 100);
    for (const it of ["A1", "A2", "A3", "NS", "TMP"])
        batch(it, 2, "XXX666", "2099-12-31", 1_000_000, 1);
    const user = (u, role, loc) => db.run("INSERT INTO users(username,display_name,password_hash,role,location_id,created_at) VALUES (?,?,?,?,?,?)", [u, `${u} user`, hashPassword("test1234"), role, loc, T0]);
    user("admin", "admin", null);
    user("pharm", "pharmacist", 2);
    user("pharm_b", "pharmacist", 2);
    user("icu", "pharmacist", 1);
    user("view", "viewer", 2);
    db.run("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'owner') WHERE role = 'admin'"); // the first admin is the system's owner, as on a real install
    // the safety checks (core/safety.ts) ask before duplicate orders, which these tests make on purpose; safety.test.ts switches them on
    db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('safety.enabled', '0')");
    const app = await buildApp({ webDist: "/nonexistent" });
    const findings = [];
    const sessions = new Map();
    const login = async (username, locationId) => {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "test1234", locationId } });
        if (r.statusCode !== 200)
            throw new Error(`login ${username}: ${r.body}`);
        const c = r.cookies.find((x) => x.name === "hps_session").value;
        sessions.set(username, c);
        return c;
    };
    const fpSql = TABLES.map((t) => `SELECT '${t}' t, COUNT(*) n, COALESCE(MAX(rowid),0) m FROM ${t}`).join(" UNION ALL ");
    const fingerprint = () => JSON.stringify([db.all(fpSql), db.get("SELECT TOTAL(qty) q FROM batches"),
        db.get("SELECT TOTAL(qty_per_dose) + TOTAL(frequency_hours) + TOTAL(duration_days) q, group_concat(status) s, group_concat(updated_at) u FROM medication_orders"),
        db.get("SELECT group_concat(active) a, group_concat(IFNULL(department_id,'')) d, group_concat(updated_at) u FROM patients"),
        db.get("SELECT TOTAL(qty) + TOTAL(dispensed_qty) q, group_concat(IFNULL(item_id,'')) i FROM walkin_lines")]);
    const maxAudit = () => db.get("SELECT COALESCE(MAX(id),0) m FROM audit_log").m;
    const totalChanges = () => db.raw.prepare("SELECT total_changes() n").get().n;
    const call = async (who, method, url, payload, expect) => {
        const a0 = maxAudit(), c0 = totalChanges(), fp0 = fingerprint();
        const r = await app.inject({ method: method, url, payload: payload, cookies: { hps_session: sessions.get(who) } });
        const auditRows = db.get("SELECT COUNT(*) n FROM audit_log WHERE id > ?", [a0]).n;
        const changed = totalChanges() - c0 - auditRows > 0 && fingerprint() !== fp0;
        const tag = `${who} ${method} ${url} ${JSON.stringify(payload ?? null).slice(0, 160)}`;
        if (r.statusCode >= 500)
            findings.push(`5xx: ${tag} → ${r.body.slice(0, 200)}`);
        if (r.statusCode >= 400 && fingerprint() !== fp0)
            findings.push(`write on a failed request: ${tag} → ${r.statusCode}`);
        if (r.statusCode < 300 && method !== "GET" && changed && auditRows === 0 && !/\/chat\/(heartbeat|read)$/.test(url))
            findings.push(`state change without audit: ${tag}`);
        if (method === "GET" && fingerprint() !== fp0)
            findings.push(`GET changed data: ${tag}`);
        const want = expect === undefined ? null : Array.isArray(expect) ? expect : [expect];
        if (want && !want.includes(r.statusCode))
            findings.push(`status ${r.statusCode} (want ${want.join("/")}): ${tag} → ${r.body.slice(0, 200)}`);
        let body = null;
        try {
            body = r.body ? JSON.parse(r.body) : null;
        }
        catch {
            body = r.body;
        }
        return { status: r.statusCode, body };
    };
    const invariants = (step) => checkInvariants(db, (s) => findings.push(`[${step}] ${s}`));
    return { db, app, findings, login, call, invariants };
}
/** The stock and dispensing invariants of a database (a test world, or a real PC's copy). */
export function checkInvariants(db, F) {
    // every batch: on hand = its ledger (opening import + every movement since), finite and never negative
    for (const b of db.all(`SELECT b.id, b.qty, COALESCE(SUM(m.qty_delta),0) s FROM batches b LEFT JOIN stock_movements m ON m.batch_id=b.id GROUP BY b.id`))
        if (!Number.isFinite(b.qty) || b.qty < 0 || Math.abs(b.qty - b.s) > 0.0005)
            F(`batch ${b.id} on hand ${b.qty} vs ledger ${b.s}`);
    // every dispense / return row has exactly one movement of the opposite / same sign on the same batch, and vice versa
    for (const x of db.all(`SELECT x.id, x.type, x.qty, x.batch_id, COUNT(m.id) n, TOTAL(m.qty_delta) s, MIN(m.batch_id) mb
     FROM dispenses x LEFT JOIN stock_movements m ON m.dispense_id = x.id GROUP BY x.id`)) {
        const want = x.type === "return" ? x.qty : -x.qty;
        if (x.n !== 1 || Math.abs(x.s - want) > 0.0005 || x.mb !== x.batch_id || !(x.qty > 0))
            F(`dispense ${x.id} (${x.type} ${x.qty}) has ${x.n} movements summing ${x.s}`);
    }
    for (const m of db.all(`SELECT m.id FROM stock_movements m WHERE m.kind IN ('dispense','return') AND NOT EXISTS (SELECT 1 FROM dispenses x WHERE x.id = m.dispense_id)`))
        F(`movement ${m.id} has no dispense row`);
    // a run dispenses exactly the dose slots it records; a mid-day / drip dispense records no more slots than it covers
    for (const r of db.all(`SELECT x.run_id, x.order_id, x.type, ROUND(SUM(x.qty),3) q, o.qty_per_dose qpd,
            (SELECT COUNT(*) FROM dispensed_slots s WHERE s.run_id = x.run_id AND s.order_id = x.order_id) slots
     FROM dispenses x JOIN medication_orders o ON o.id = x.order_id WHERE x.type IN ('run_24h','selected_times','midday','drip')
     GROUP BY x.run_id, x.order_id`)) {
        const perDose = r.qpd > 0 ? r.qpd : 1;
        const isRun = r.type === "run_24h" || r.type === "selected_times";
        if (isRun ? Math.abs(r.q - r.slots * perDose) > 0.0005 : r.slots * perDose > r.q + 0.0005)
            F(`${r.type} ${r.run_id} order ${r.order_id}: ${r.q} dispensed for ${r.slots} slots of ${r.qpd}`);
    }
    // a run row never records a slot it did not dispense
    for (const s of db.all(`SELECT s.order_id, s.slot_at, s.run_id FROM dispensed_slots s WHERE NOT EXISTS (SELECT 1 FROM dispenses x WHERE x.run_id = s.run_id AND x.order_id = s.order_id)`))
        F(`slot ${s.order_id}@${s.slot_at} recorded by ${s.run_id} without a dispense`);
    // walk-in lines: dispensed quantity = what was dispensed for the ticket, never more than the line asks
    for (const w of db.all(`SELECT t.id, l.item_id, ROUND(SUM(l.dispensed_qty),3) dq,
            ROUND(COALESCE((SELECT SUM(x.qty) FROM dispenses x WHERE x.walkin_ticket_id = t.id AND x.item_id = l.item_id AND x.type='walkin'),0),3) xq
     FROM walkin_tickets t JOIN walkin_lines l ON l.ticket_id = t.id GROUP BY t.id, l.item_id`))
        if (Math.abs(w.dq - w.xq) > 0.0005)
            F(`ticket ${w.id} ${w.item_id}: lines say ${w.dq}, dispenses ${w.xq}`);
    for (const w of db.all("SELECT id, qty, dispensed_qty FROM walkin_lines WHERE dispensed_qty > qty + 0.0005"))
        F(`walk-in line ${w.id} over-dispensed`);
    // orders keep quantities the schedule and FEFO can work with
    for (const o of db.all("SELECT id, qty_per_dose q FROM medication_orders WHERE NOT (qty_per_dose >= 0.001)"))
        F(`order ${o.id} qty per dose ${o.q}`);
}
