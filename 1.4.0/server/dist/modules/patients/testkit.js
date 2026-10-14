import { openDb } from "../../db/index.js";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../auth/passwords.js";
const T0 = "2026-01-01T00:00:00";
export async function makeKit() {
    const db = openDb(":memory:");
    db.run("INSERT INTO locations(id,name) VALUES (1,'ICU'),(2,'EMR')");
    db.run("INSERT INTO departments(id,name,location_id) VALUES (10,'Ward A',2),(11,'Ward B',2),(20,'ICU Bay',1)");
    db.run("INSERT INTO departments(id,name,location_id,active) VALUES (12,'Closed ward',2,0)");
    db.run(`INSERT INTO items(id,item_no,name,unit,default_route,default_frequency,default_dose,default_notes) VALUES
    ('A00001',1,'Paracetamol 500mg','tab',NULL,NULL,NULL,NULL),
    ('A00002',2,'Ceftriaxone 1g','vial','وريد',12,'1g','بعد الأكل'),
    ('A00003',3,'Normal Saline 500mL','bag',NULL,NULL,NULL,NULL)`);
    const batch = (item, loc, no, exp, qty, ph = 0) => db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,?,?)", [item, loc, no, exp, qty, ph, T0]);
    batch("A00001", 2, "P-EARLY", "2027-06-30", 2);
    batch("A00001", 2, "P-LATE", "2029-01-31", 8);
    batch("A00001", 2, "P-OLD", "2020-01-01", 100); // expired: never counted or dispensed
    batch("A00001", 1, "P-ICU", "2029-01-31", 50); // other pharmacy
    batch("A00002", 2, "C-1", "2028-01-01", 1);
    batch("A00003", 2, "NS-1", "2028-01-01", 20);
    batch("A00003", 2, "XXX666", "2099-12-31", 1000000, 1);
    const user = (u, role, loc) => db.run("INSERT INTO users(username,display_name,password_hash,role,location_id,created_at) VALUES (?,?,?,?,?,?)", [u, u, hashPassword("pw123456"), role, loc, T0]);
    user("pharm", "pharmacist", 2);
    user("view", "viewer", 2);
    user("icu", "pharmacist", 1);
    db.run("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'owner') WHERE role = 'admin'"); // the first admin is the system's owner, as on a real install
    const patient = (id, name, dept, active = 1, dob = "1980-05-05") => db.run("INSERT INTO patients(id,name,department_id,dob,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", [id, name, dept, dob, active, T0, T0]);
    patient("900000001", "مريض أول", 10);
    patient("900000002", "مريض العناية", 20);
    patient("900000003", "مريض غير نشط", 11, 0);
    patient("900000004", "مريض ثان", 11);
    // the safety checks (core/safety.ts) ask before duplicate orders, which these tests make on purpose; safety.test.ts switches them on
    db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('safety.enabled', '0')");
    const app = await buildApp({ webDist: "/nonexistent" });
    const login = async (username) => {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "pw123456" } });
        if (r.statusCode !== 200)
            throw new Error(`login ${username}: ${r.body}`);
        const c = r.cookies.find((x) => x.name === "hps_session");
        return `${c.name}=${c.value}`;
    };
    return { db, app, pharm: await login("pharm"), viewer: await login("view"), icu: await login("icu") };
}
/** app.inject wrapper: call(kit.pharm, "POST", "/api/...", body) → { status, body } */
export async function call(app, cookie, method, url, payload) {
    const r = await app.inject({ method, url, payload: payload, headers: { cookie } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
