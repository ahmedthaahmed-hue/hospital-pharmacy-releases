// Development only: create test users on the demo database, one per built-in role.  npx tsx src/db/dev-users.ts
import { openDb } from "./index.js";
import { hashPassword } from "../auth/passwords.js";
import { BUILTIN_ROLES, levelFor } from "../core/permissions.js";
import { nowIso } from "../lib/time.js";
const db = openDb(process.env.DB_FILE ?? "data/pharmacy.sqlite");
const up = (u, name, key, loc) => {
    const perms = BUILTIN_ROLES.find((r) => r.key === key).permissions;
    const roleId = db.get("SELECT id FROM roles WHERE key = ?", [key])?.id ?? null;
    db.run(`INSERT INTO users(username,display_name,password_hash,role,role_id,location_id,must_change_password,created_at) VALUES (?,?,?,?,?,?,0,?)
          ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, role_id=excluded.role_id,
            location_id=excluded.location_id, must_change_password=0`, [u, name, hashPassword("test1234"), levelFor(perms), roleId, loc, nowIso()]);
};
up("admin", "مدير النظام", "owner", null);
up("manager", "مدير الصيدلية", "manager", null);
up("senior", "د. منى (صيدلي أول)", "senior", 2);
up("pharm", "د. سارة (صيدلي)", "pharmacist", 2);
up("view", "مراجع", "viewer", 2);
console.log("dev users: admin (owner) / manager / senior / pharm / view — password test1234");
