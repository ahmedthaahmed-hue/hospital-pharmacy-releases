import { openDb } from "../../db/index.js";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../auth/passwords.js";
export async function setup() {
    const db = openDb(":memory:");
    db.run("INSERT INTO locations(id,name) VALUES (1,'EMR'),(2,'ICU')");
    db.run("INSERT INTO departments(id,name,location_id) VALUES (10,'Ward A',1),(11,'ICU Beds',2),(12,'Orphan',NULL)");
    const pt = (id, name, dept, active = 1, child = 0, notes = null) => db.run("INSERT INTO patients(id,name,department_id,active,is_child,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,'2026-01-01T00:00:00','2026-01-01T00:00:00')", [id, name, dept, active, child, notes]);
    pt("P1", "Alpha", 10);
    pt("P2", "Beta", 10, 1, 1, "حساسية بنسلين");
    pt("P3", "Gamma (other pharmacy)", 11);
    pt("P4", "Delta (inactive)", 10, 0);
    pt("P5", "Echo (orphan dept)", 12);
    db.run("INSERT INTO items(id,item_no,name,unit) VALUES ('A1',1,'Paracetamol 500mg','Tab'),('A2',2,'Omeprazole 40mg','Vial'),('A3',3,'Ceftriaxone 1g','Vial')");
    // the safety checks (core/safety.ts) ask before duplicate orders, which these tests make on purpose; safety.test.ts switches them on
    db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('safety.enabled', '0')");
    const app = await buildApp({ webDist: "/nonexistent" });
    const users = {};
    for (const [u, role, loc] of [["admin", "admin", null], ["pharm", "pharmacist", 1], ["view", "viewer", 1]]) {
        users[u] = db.run("INSERT INTO users(username,display_name,password_hash,role,location_id,created_at) VALUES (?,?,?,?,?,'2026-01-01T00:00:00')", [u, `${u} user`, hashPassword("test1234"), role, loc]).lastId;
    }
    db.run("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'owner') WHERE role = 'admin'"); // the first admin is the system's owner, as on a real install
    const login = async (username, locationId) => {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "test1234", locationId } });
        if (r.statusCode !== 200)
            throw new Error(`login failed: ${r.body}`);
        const c = r.headers["set-cookie"];
        return (Array.isArray(c) ? c[0] : String(c)).split(";")[0];
    };
    const cookie = await login("pharm");
    return {
        db, app, cookie,
        as: (role) => login(role === "admin" ? "admin" : role === "viewer" ? "view" : "pharm", role === "admin" ? 1 : undefined),
    };
}
export function addBatch(db, item, qty, opts = {}) {
    return db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,?,'2026-01-01T00:00:00')", [item, opts.loc ?? 1, opts.no ?? `B-${item}-${Math.random().toString(36).slice(2, 7)}`, opts.exp === undefined ? "2030-01-01" : opts.exp, qty, opts.placeholder ? 1 : 0]).lastId;
}
export function addOrder(db, o) {
    return db.run(`INSERT INTO medication_orders(patient_id,item_id,frequency_hours,qty_per_dose,order_type,start_date,first_dose_time,duration_days,status,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'2026-01-01T00:00:00','2026-01-01T00:00:00')`, [o.patient, o.item, o.freq === undefined ? 8 : o.freq, o.qpd ?? 1, o.type ?? "regular", o.start ?? "2026-11-01", o.first ?? "06:00",
        o.days === undefined ? null : o.days, o.status ?? "active", o.notes ?? null]).lastId;
}
export const stockOf = (db, item, loc = 1) => Math.round((db.get("SELECT COALESCE(SUM(qty),0) q FROM batches WHERE item_id=? AND location_id=?", [item, loc]).q) * 1000) / 1000;
