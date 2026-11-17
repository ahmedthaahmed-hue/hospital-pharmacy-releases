import { openDb } from "../../db/index.js";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../auth/passwords.js";
import { nowIso, toLocalDate, addDays } from "../../lib/time.js";
export const PW = "secret123";
export const dayOffset = (n) => toLocalDate(addDays(new Date(), n));
export async function harness() {
    const db = openDb(":memory:");
    db.run("INSERT INTO locations(id,name) VALUES (1,'EMR'),(2,'ICU')");
    const hash = hashPassword(PW);
    for (const [u, role, loc] of [["admin", "admin", null], ["pharm", "pharmacist", 1], ["pharm2", "pharmacist", 2], ["view", "viewer", 1]])
        db.run("INSERT INTO users(username,display_name,password_hash,role,location_id,created_at) VALUES (?,?,?,?,?,?)", [u, u, hash, role, loc, nowIso()]);
    db.run("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'owner') WHERE role = 'admin'"); // the first admin is the system's owner, as on a real install
    db.run("INSERT INTO items(id,item_no,name,unit) VALUES ('A00001',1,'Paracetamol 500','قرص'),('A00002',2,'Amoxicillin 1g','فيال')");
    const app = await buildApp({ webDist: "/nonexistent" });
    const as = async (user) => {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: user, password: PW } });
        if (r.statusCode !== 200)
            throw new Error(`login ${user}: ${r.body}`);
        const cookie = r.cookies.find((c) => c.name === "hps_session").value;
        return async (method, url, payload) => {
            const res = await app.inject({ method, url, payload: payload, cookies: { hps_session: cookie } });
            return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
        };
    };
    return { db, app, as };
}
/** Every batch's quantity equals the sum of its ledger rows. */
export function ledgerMismatches(db) {
    return db.all(`SELECT b.id, b.qty, COALESCE(SUM(m.qty_delta),0) s FROM batches b LEFT JOIN stock_movements m ON m.batch_id=b.id
                 GROUP BY b.id HAVING ABS(b.qty - COALESCE(SUM(m.qty_delta),0)) > 0.0005`);
}
