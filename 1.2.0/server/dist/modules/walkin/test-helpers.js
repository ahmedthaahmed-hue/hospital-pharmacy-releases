import { openDb } from "../../db/index.js";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../auth/passwords.js";
let app = null;
export async function fixture() {
    const db = openDb(":memory:");
    db.run("INSERT INTO locations(id,name) VALUES (1,'ICU'),(2,'EMR')");
    db.run("INSERT INTO departments(id,name,location_id) VALUES (1,'ICU A',1),(2,'Emergency',2)");
    db.run("INSERT INTO routes(name) VALUES ('بالفم'),('وريد')");
    const item = (id, no, name, unit, strength, dose, route) => db.run("INSERT INTO items(id,item_no,name,unit,strength,default_dose,default_route,default_frequency) VALUES (?,?,?,?,?,?,?,8)", [id, no, name, unit, strength, dose, route]);
    item("A00001", 1, "Paracetamol 500", "قرص", "500 mg", "1 tab", "بالفم");
    item("A00002", 2, "Ceftriaxone 1g", "فيال", null, "1 g", "وريد");
    item("A00003", 3, "Gauze", "علبة", null, null, null);
    item("A00004", 4, "Lidocaine 2%", "امبول", "2%", null, "موضعي");
    const users = [["admin", "admin", null], ["pharm", "pharmacist", 2], ["pharm1", "pharmacist", 1], ["view", "viewer", 2]];
    for (const [u, role, loc] of users)
        db.run("INSERT INTO users(username,display_name,password_hash,role,location_id,created_at) VALUES (?,?,?,?,?,'2026-01-01T00:00:00')", [u, u, hashPassword("test1234"), role, loc]);
    db.run("INSERT INTO patients(id,name,department_id,active,created_at,updated_at) VALUES ('P1','Patient One',2,1,'2026-01-01T00:00:00','2026-01-01T00:00:00')");
    db.run("INSERT INTO patients(id,name,department_id,active,created_at,updated_at) VALUES ('P2','Patient Two',2,0,'2026-01-01T00:00:00','2026-01-01T00:00:00')");
    if (!app)
        app = await buildApp({ webDist: "/nonexistent-web-dist" });
    const a = app;
    const as = async (user) => {
        const res = await a.inject({ method: "POST", url: "/api/auth/login", payload: { username: user, password: "test1234", locationId: user === "admin" ? 2 : undefined } });
        if (res.statusCode !== 200)
            throw new Error(`login failed ${res.body}`);
        const c = res.cookies.find((x) => x.name === "hps_session");
        return async (method, url, body) => {
            const r = await a.inject({ method, url, payload: body, cookies: { hps_session: c.value } });
            return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
        };
    };
    return { app: a, db, as };
}
export function addBatch(db, itemId, locationId, qty, opts = {}) {
    return db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,?,'2026-01-01T00:00:00')", [itemId, locationId, opts.batchNo ?? `B${Math.random().toString(36).slice(2, 8)}`, opts.expiry === undefined ? "2030-01-01" : opts.expiry, qty, opts.placeholder ? 1 : 0]).lastId;
}
