// Development only: create test users on the demo database.  npx tsx src/db/dev-users.ts
import { openDb } from "./index.js";
import { hashPassword } from "../auth/passwords.js";
import { nowIso } from "../lib/time.js";
const db = openDb(process.env.DB_FILE ?? "data/pharmacy.sqlite");
const up = (u, name, role, loc) => db.run(`INSERT INTO users(username,display_name,password_hash,role,location_id,must_change_password,created_at) VALUES (?,?,?,?,?,0,?)
          ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, location_id=excluded.location_id, must_change_password=0`, [u, name, hashPassword("test1234"), role, loc, nowIso()]);
up("admin", "مدير النظام", "admin", null);
up("pharm", "د. سارة (صيدلي)", "pharmacist", 2);
up("view", "مراجع", "viewer", 2);
console.log("dev users: admin / pharm / view — password test1234");
