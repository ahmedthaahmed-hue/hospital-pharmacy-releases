// Administration: users & sessions, pharmacies & departments, lookups, settings, backups, audit log, system info.
// Each part needs its own permission (preHandler below, core/permissions.ts).
//
// Deliberate changes vs legacy (FEATURES.md §1.1, §1.2, §5):
//  - Legacy had no users at all; identity was the workstation's pharmacy. Now: per-user logins and roles.
//  - The hardcoded licence password / 2027-01-01 expiry lock (AutoExec_Logic, License — bug §5.1) is removed
//    and NOT reimplemented: access control is the user accounts below.
//  - Departments are referenced by id (bug §5.6 / §4.2): renaming a department or moving it to another pharmacy
//    keeps its patients attached. Legacy joined on the department *name*, so a rename orphaned patients.
//  - Departments are created from a managed list with a pharmacy picker (legacy free-text InputBox, bug §5.29).
import { featureOn, featureStates } from "../../core/feature-gate.js";
import { ALWAYS_ON, FEATURES, featureSettingKey } from "../../core/features.js";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { hashPassword } from "../../auth/passwords.js";
import { audit, bad, can, HttpError, notFound, parse, requirePerm, zBool, zDate, zId } from "../../lib/http.js";
import { assertHomePharmacy, assertMayManage, isLastOwner, roleRoutes, roleToGive } from "./roles.js";
import { nowIso } from "../../lib/time.js";
import { BACKUP_RE, backupDir, keepDays, listBackups, restartBackupSchedule, runBackup } from "./backup.js";
import { checkAndCopy, copyDir, dirExists, recentChecks } from "./backup-check.js";
import { checkDatabase, healthReport } from "./health.js";
import { adminLayoutRoutes } from "../layouts/routes.js";
import { allSettings, crossCheck, settingNum, settingsSchema, SETTINGS, SETTINGS_BODY } from "../../core/settings.js";
const SETTINGS_KEYS_EDITABLE = SETTINGS.filter((d) => !d.readonly).map((d) => d.key);
const here = dirname(fileURLToPath(import.meta.url));
const zRole = z.enum(["admin", "pharmacist", "viewer"]);
const zName = (what, max = 120) => z.string().trim().min(1, `Enter the ${what}`).max(max, `The ${what} is too long`);
/** Password rule; the minimum length is the 'auth.password_min' setting (checked at request time). */
const zPassword = z.string().max(200).superRefine((v, ctx) => {
    const min = settingNum("auth.password_min");
    if (v.length < min)
        ctx.addIssue({ code: "custom", message: `Password must be at least ${min} characters` });
});
const zLocRef = z.coerce.number().int().positive().nullable();
const idParam = (req) => parse(z.object({ id: zId }), req.params).id;
/** "version" from server/package.json, else the root package.json; null when neither declares one. */
function appVersion() {
    for (const p of ["../../../package.json", "../../../../package.json"]) {
        try {
            const v = JSON.parse(readFileSync(resolve(here, p), "utf8")).version;
            if (v)
                return String(v);
        }
        catch { /* try next */ }
    }
    return null;
}
function assertLocation(id, { activeOnly = true } = {}) {
    if (id == null)
        return;
    const l = db().get("SELECT active FROM locations WHERE id=?", [id]);
    if (!l)
        throw notFound("Pharmacy");
    if (activeOnly && !l.active)
        throw bad("The pharmacy is inactive — activate it first or choose another pharmacy");
}
const HHMM = z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Time as HH:MM (00:00 – 23:59)")
    .transform((v) => v.padStart(5, "0"));
const LOOKUPS = {
    routes: {
        table: "routes", label: "Route", select: "id, name, active", order: "id",
        create: z.object({ name: zName("route name", 60), active: zBool.optional() }),
        patch: z.object({ name: zName("route name", 60).optional(), active: zBool.optional() }),
    },
    frequencies: {
        table: "frequencies", label: "Frequency", select: "id, hours, description", order: "hours",
        create: z.object({ hours: z.coerce.number().min(1 / 12, "Frequency must be at least every 5 minutes").max(24 * 60, "Too many hours"), description: z.string().trim().max(120).nullish().transform((v) => v || null) }),
        patch: z.object({ hours: z.coerce.number().min(1 / 12, "Frequency must be at least every 5 minutes").max(24 * 60).optional(), description: z.string().trim().max(120).nullish().transform((v) => v || null).optional() }), // absent = unchanged
    },
    "dose-times": {
        table: "dose_times", label: "Dose time", select: "id, time", order: "time",
        create: z.object({ time: HHMM }), patch: z.object({ time: HHMM.optional() }),
    },
    statuses: {
        table: "patient_statuses", label: "Patient status", select: "id, name", order: "id",
        create: z.object({ name: zName("status name", 60) }), patch: z.object({ name: zName("status name", 60).optional() }),
    },
};
const zKind = z.enum(["routes", "frequencies", "dose-times", "statuses"]);
/* ---------------- Settings ---------------- */
// Editable keys and their validation. schedule.* are shown read-only (the schedule engine owns the 06:00 day).
// Settings: validation, defaults and metadata live in core/settings.ts (the registry).
/** The permission each part of /api/admin needs (layouts check their own: screens and labels differ). */
const SECTION_PERM = [
    [/^\/api\/admin\/(users|sessions|roles)(\/|$)/, "admin.users"],
    [/^\/api\/admin\/(locations|departments|lookups)(\/|$)/, "admin.pharmacies"],
    [/^\/api\/admin\/(settings|features)(\/|$)/, "admin.settings"],
    [/^\/api\/admin\/backups(\/|$)/, "admin.backups"],
    [/^\/api\/admin\/(audit|system|health)(\/|$)/, "admin.audit"],
];
export default async function routes(app) {
    app.addHook("preHandler", async (req) => {
        const url = req.routeOptions?.url ?? "";
        if (/^\/api\/admin\/layouts(\/|$)/.test(url))
            return;
        const perm = SECTION_PERM.find(([re]) => re.test(url))?.[1];
        // the audit log's filter lists the accounts (read only); anything not listed is refused
        if (url === "/api/admin/users" && req.method === "GET" && can(req.ctx, "admin.audit"))
            return;
        if (!perm)
            throw new HttpError(403, "Only an admin can do this");
        requirePerm(req, perm);
    });
    await app.register(adminLayoutRoutes, { prefix: "/layouts" });
    await app.register(roleRoutes, { prefix: "/roles" });
    /* ======== Users ======== */
    const userRow = `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.role_id AS roleId, r.name AS roleName, r.key AS roleKey,
      u.location_id AS locationId, l.name AS locationName,
      u.active, u.must_change_password AS mustChangePassword, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
      u.badge_code AS badgeCode, u.pin_hash IS NOT NULL AS hasPin, u.totp_enabled AS totpEnabled,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at > ?) AS sessionCount
    FROM users u LEFT JOIN locations l ON l.id = u.location_id LEFT JOIN roles r ON r.id = u.role_id`;
    const target = (id) => db().get("SELECT * FROM users WHERE id=?", [id]);
    app.get("/users", async () => db().all(`${userRow} ORDER BY u.active DESC, r.sort, u.display_name`, [nowIso()]));
    app.post("/users", async (req) => {
        const b = parse(z.object({
            username: z.string().trim().min(2, "Username must be at least 2 characters").max(40).regex(/^[A-Za-z0-9._-]+$/, "Username can only use English letters, digits and . _ -"),
            displayName: zName("display name", 80),
            roleId: zId.nullish(),
            role: zRole.nullish(),
            locationId: zLocRef.optional().default(null),
            password: zPassword,
        }), req.body);
        const given = roleToGive(req, b);
        assertHomePharmacy(req, b.locationId);
        assertLocation(b.locationId);
        if (db().get("SELECT 1 FROM users WHERE username=?", [b.username]))
            throw new HttpError(409, "Username is already taken");
        // Initial password is chosen by the admin, so the user must replace it on first login.
        const r = db().run("INSERT INTO users(username,display_name,password_hash,role,role_id,location_id,active,must_change_password,created_at) VALUES (?,?,?,?,?,?,1,1,?)", [b.username, b.displayName, hashPassword(b.password), given.level, given.id, b.locationId, nowIso()]);
        audit(req, "admin.user.create", "user", r.lastId, { username: b.username, roleId: given.id, locationId: b.locationId });
        return db().get(`${userRow} WHERE u.id=?`, [nowIso(), r.lastId]);
    });
    app.patch("/users/:id", async (req) => {
        const id = idParam(req);
        const b = parse(z.object({
            username: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/, "Username can only use English letters, digits and . _ -").optional(),
            displayName: zName("display name", 80).optional(),
            roleId: zId.nullish(),
            role: zRole.nullish(),
            locationId: zLocRef.optional(),
            active: zBool.optional(),
        }), req.body);
        return db().tx(() => {
            const u = target(id);
            if (!u)
                throw notFound("User");
            assertMayManage(req, u);
            const given = b.roleId != null || b.role ? roleToGive(req, b) : null;
            const roleId = given?.id ?? u.role_id;
            const role = given?.level ?? u.role;
            const active = b.active ?? u.active;
            const changesRole = roleId !== u.role_id;
            if (id === req.ctx.userId && (changesRole || !active))
                throw bad("You cannot deactivate your own account or change your own role");
            if ((changesRole || !active) && u.active && isLastOwner(id))
                throw bad("This is the only owner — give another account the owner role first");
            if (b.locationId !== undefined && b.locationId !== u.location_id) {
                assertHomePharmacy(req, b.locationId);
                assertLocation(b.locationId);
            }
            if (b.username && b.username.toLowerCase() !== String(u.username).toLowerCase()
                && db().get("SELECT 1 FROM users WHERE username=? AND id<>?", [b.username, id]))
                throw new HttpError(409, "Username is already taken");
            db().run("UPDATE users SET username=?, display_name=?, role=?, role_id=?, location_id=?, active=? WHERE id=?", [
                b.username ?? u.username, b.displayName ?? u.display_name, role, roleId,
                b.locationId === undefined ? u.location_id : b.locationId, active, id
            ]);
            // Deactivated users, role and home-pharmacy changes take effect immediately: drop their sessions (an admin changing
            // their own home pharmacy keeps the session they are using, like a password change).
            const movesLocation = b.locationId !== undefined && b.locationId !== u.location_id;
            if (!active || changesRole || movesLocation)
                db().run("DELETE FROM sessions WHERE user_id=? AND token<>?", [id, id === req.ctx.userId ? req.ctx.token : ""]);
            audit(req, "admin.user.update", "user", id, b);
            return db().get(`${userRow} WHERE u.id=?`, [nowIso(), id]);
        });
    });
    app.post("/users/:id/reset-password", async (req) => {
        const id = idParam(req);
        const b = parse(z.object({ password: zPassword }), req.body);
        if (id === req.ctx.userId)
            throw bad("To change your own password, use “Change password” in the menu");
        const u = target(id);
        if (!u)
            throw notFound("User");
        assertMayManage(req, u);
        db().tx(() => {
            db().run("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?", [hashPassword(b.password), id]);
            db().run("DELETE FROM sessions WHERE user_id=?", [id]);
        });
        audit(req, "admin.user.reset_password", "user", id);
        return { ok: true };
    });
    /** A new badge for the user (the card printed from here); the old card stops working. */
    app.post("/users/:id/badge", async (req) => {
        const id = idParam(req);
        const u = target(id);
        if (!u)
            throw notFound("User");
        if (id !== req.ctx.userId)
            assertMayManage(req, u);
        let code = "";
        do
            code = `HP${randomBytes(6).toString("hex").toUpperCase()}`;
        while (db().get("SELECT 1 FROM users WHERE badge_code = ?", [code]));
        db().run("UPDATE users SET badge_code = ? WHERE id = ?", [code, id]);
        audit(req, "admin.user.badge", "user", id);
        return { badgeCode: code };
    });
    app.delete("/users/:id/badge", async (req) => {
        const id = idParam(req);
        const u = target(id);
        if (!u)
            throw notFound("User");
        if (id !== req.ctx.userId)
            assertMayManage(req, u);
        db().run("UPDATE users SET badge_code = NULL WHERE id = ?", [id]);
        audit(req, "admin.user.badge_removed", "user", id);
        return { ok: true };
    });
    /** A user who lost their phone and their recovery codes: two-step sign-in off, to set up again at sign-in. */
    app.post("/users/:id/reset-two-step", async (req) => {
        const id = idParam(req);
        if (id === req.ctx.userId)
            throw bad("Turn your own two-step sign-in off from your menu");
        const u = target(id);
        if (!u)
            throw notFound("User");
        assertMayManage(req, u);
        db().tx(() => {
            db().run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery = NULL, totp_last_step = NULL WHERE id = ?", [id]);
            db().run("DELETE FROM sessions WHERE user_id = ?", [id]);
        });
        audit(req, "admin.user.reset_two_step", "user", id);
        return { ok: true };
    });
    /* ======== Sessions ======== */
    app.get("/sessions", async (req) => {
        const rows = db().all(`SELECT s.rowid AS id, s.token, s.user_id AS userId, u.username, u.display_name AS displayName, u.role, r.name AS roleName,
              s.location_id AS locationId, l.name AS locationName, s.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN locations l ON l.id=s.location_id LEFT JOIN roles r ON r.id=u.role_id
       WHERE s.expires_at > ? ORDER BY s.created_at DESC`, [nowIso()]);
        // Never expose tokens.
        return rows.map(({ token, ...r }) => ({ ...r, current: token === req.ctx.token }));
    });
    app.delete("/sessions/:id", async (req) => {
        const id = idParam(req);
        const s = db().get("SELECT token, user_id FROM sessions WHERE rowid=?", [id]);
        if (!s)
            throw notFound("Session");
        if (s.token === req.ctx.token)
            throw bad("This is your current session — use Sign out");
        assertMayManage(req, target(s.user_id));
        db().run("DELETE FROM sessions WHERE rowid=?", [id]);
        audit(req, "admin.session.revoke", "user", s.user_id);
        return { ok: true };
    });
    /* ======== Pharmacies (locations) ======== */
    const locRow = `SELECT l.id, l.name, l.active,
      (SELECT COUNT(*) FROM departments d WHERE d.location_id=l.id) AS departmentCount,
      (SELECT COUNT(*) FROM patients p JOIN departments d ON d.id=p.department_id WHERE d.location_id=l.id AND p.active=1) AS patientCount,
      (SELECT COUNT(*) FROM users u WHERE u.location_id=l.id AND u.active=1) AS userCount,
      (SELECT COUNT(*) FROM batches b WHERE b.location_id=l.id AND b.qty>0) AS batchCount
    FROM locations l`;
    app.get("/locations", async () => db().all(`${locRow} ORDER BY l.id`));
    app.post("/locations", async (req) => {
        const b = parse(z.object({ name: zName("pharmacy name", 80) }), req.body);
        const r = db().run("INSERT INTO locations(name,active) VALUES (?,1)", [b.name]);
        audit(req, "admin.location.create", "location", r.lastId, b);
        return db().get(`${locRow} WHERE l.id=?`, [r.lastId]);
    });
    app.patch("/locations/:id", async (req) => {
        const id = idParam(req);
        const b = parse(z.object({ name: zName("pharmacy name", 80).optional(), active: zBool.optional() }), req.body);
        return db().tx(() => {
            const l = db().get("SELECT * FROM locations WHERE id=?", [id]);
            if (!l)
                throw notFound("Pharmacy");
            if (b.active === 0 && l.active) {
                if (!db().get("SELECT COUNT(*) c FROM locations WHERE active=1 AND id<>?", [id]).c)
                    throw bad("Cannot deactivate the last active pharmacy");
                if (req.ctx.locationId === id)
                    throw bad("You are working as this pharmacy now — switch to another pharmacy first");
            }
            db().run("UPDATE locations SET name=?, active=? WHERE id=?", [b.name ?? l.name, b.active ?? l.active, id]);
            // Sessions working as a stopped pharmacy end now (they would otherwise keep writing to it).
            if (b.active === 0)
                db().run("DELETE FROM sessions WHERE location_id=?", [id]);
            audit(req, "admin.location.update", "location", id, b);
            return db().get(`${locRow} WHERE l.id=?`, [id]);
        });
    });
    /** Hard delete only when nothing references the pharmacy; otherwise the FK refuses and we explain. */
    app.delete("/locations/:id", async (req) => {
        const id = idParam(req);
        const l = db().get("SELECT name FROM locations WHERE id=?", [id]);
        if (!l)
            throw notFound("Pharmacy");
        try {
            db().tx(() => {
                db().run("DELETE FROM chat_presence WHERE location_id=?", [id]);
                db().run("DELETE FROM locations WHERE id=?", [id]);
            });
        }
        catch (e) {
            if (/FOREIGN KEY/.test(String(e?.message)))
                throw new HttpError(409, "The pharmacy is linked to data (departments, stock, dispensing or users) — deactivate it instead of deleting it");
            throw e;
        }
        audit(req, "admin.location.delete", "location", id, { name: l.name });
        return { ok: true };
    });
    /* ======== Departments ======== */
    const deptRow = `SELECT d.id, d.name, d.location_id AS locationId, l.name AS locationName, d.active,
      (SELECT COUNT(*) FROM patients p WHERE p.department_id=d.id AND p.active=1) AS patientCount,
      (SELECT COUNT(*) FROM patients p WHERE p.department_id=d.id) AS totalPatients
    FROM departments d LEFT JOIN locations l ON l.id=d.location_id`;
    app.get("/departments", async () => db().all(`${deptRow} ORDER BY d.name`));
    app.post("/departments", async (req) => {
        const b = parse(z.object({ name: zName("department name", 120), locationId: zLocRef.optional().default(null) }), req.body);
        assertLocation(b.locationId);
        if (db().get("SELECT 1 FROM departments WHERE name=?", [b.name]))
            throw new HttpError(409, "A department with this name exists");
        const r = db().run("INSERT INTO departments(name,location_id,active) VALUES (?,?,1)", [b.name, b.locationId]);
        audit(req, "admin.department.create", "department", r.lastId, b);
        return db().get(`${deptRow} WHERE d.id=?`, [r.lastId]);
    });
    app.patch("/departments/:id", async (req) => {
        const id = idParam(req);
        const b = parse(z.object({ name: zName("department name", 120).optional(), active: zBool.optional() }), req.body);
        const d = db().get("SELECT * FROM departments WHERE id=?", [id]);
        if (!d)
            throw notFound("Department");
        if (b.name && b.name !== d.name && db().get("SELECT 1 FROM departments WHERE name=? AND id<>?", [b.name, id]))
            throw new HttpError(409, "A department with this name exists");
        // Safe rename: patients reference departments by id (legacy joined by name, bug §5.6).
        db().run("UPDATE departments SET name=?, active=? WHERE id=?", [b.name ?? d.name, b.active ?? d.active, id]);
        audit(req, "admin.department.update", "department", id, { ...b, previousName: b.name && b.name !== d.name ? d.name : undefined });
        return db().get(`${deptRow} WHERE d.id=?`, [id]);
    });
    /** Move a department (and therefore all its patients) to another pharmacy, or unassign it (null). */
    app.post("/departments/:id/move", async (req) => {
        const id = idParam(req);
        const b = parse(z.object({ locationId: zLocRef }), req.body);
        const d = db().get("SELECT * FROM departments WHERE id=?", [id]);
        if (!d)
            throw notFound("Department");
        assertLocation(b.locationId);
        if (d.location_id === b.locationId)
            throw bad("The department already belongs to this pharmacy");
        const patients = db().get("SELECT COUNT(*) c FROM patients WHERE department_id=? AND active=1", [id]).c;
        db().run("UPDATE departments SET location_id=? WHERE id=?", [b.locationId, id]);
        audit(req, "admin.department.move", "department", id, { from: d.location_id, to: b.locationId, activePatients: patients });
        return db().get(`${deptRow} WHERE d.id=?`, [id]);
    });
    app.delete("/departments/:id", async (req) => {
        const id = idParam(req);
        const d = db().get("SELECT name FROM departments WHERE id=?", [id]);
        if (!d)
            throw notFound("Department");
        const n = db().get("SELECT COUNT(*) c FROM patients WHERE department_id=?", [id]).c;
        if (n)
            throw new HttpError(409, `The department is linked to ${n} patient(s) — deactivate it instead of deleting it`);
        try {
            db().run("DELETE FROM departments WHERE id=?", [id]);
        }
        catch (e) {
            if (/FOREIGN KEY/.test(String(e?.message)))
                throw new HttpError(409, "The department is linked to other data — deactivate it instead of deleting it");
            throw e;
        }
        audit(req, "admin.department.delete", "department", id, { name: d.name });
        return { ok: true };
    });
    /* ======== Lookups ======== */
    app.get("/lookups/:kind", async (req) => {
        const { kind } = parse(z.object({ kind: zKind }), req.params);
        const L = LOOKUPS[kind];
        const rows = db().all(`SELECT ${L.select} FROM ${L.table} ORDER BY ${L.order}`);
        if (kind === "statuses") {
            const used = new Map(db().all("SELECT status, COUNT(*) c FROM patients WHERE active=1 AND status IS NOT NULL GROUP BY status").map((r) => [r.status, r.c]));
            return rows.map((r) => ({ ...r, patientCount: used.get(r.name) ?? 0 }));
        }
        return rows;
    });
    app.post("/lookups/:kind", async (req) => {
        const { kind } = parse(z.object({ kind: zKind }), req.params);
        const L = LOOKUPS[kind];
        const b = parse(L.create, req.body);
        const cols = Object.keys(b).filter((k) => b[k] !== undefined);
        try {
            const r = db().run(`INSERT INTO ${L.table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => b[c]));
            audit(req, "admin.lookup.create", L.table, r.lastId, b);
            return db().get(`SELECT ${L.select} FROM ${L.table} WHERE id=?`, [r.lastId]);
        }
        catch (e) {
            if (/UNIQUE/.test(String(e?.message)))
                throw new HttpError(409, `${L.label} already exists`);
            throw e;
        }
    });
    app.patch("/lookups/:kind/:id", async (req) => {
        const { kind, id } = parse(z.object({ kind: zKind, id: zId }), req.params);
        const L = LOOKUPS[kind];
        const b = parse(L.patch, req.body);
        const cols = Object.keys(b).filter((k) => b[k] !== undefined);
        const before = db().get(`SELECT ${L.select} FROM ${L.table} WHERE id=?`, [id]);
        if (!before)
            throw notFound(L.label);
        if (!cols.length)
            return before;
        try {
            db().tx(() => {
                db().run(`UPDATE ${L.table} SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE id=?`, [...cols.map((c) => b[c]), id]);
                // Patient status is stored as text on patients; carry a rename over so filters keep matching.
                if (kind === "statuses" && typeof b.name === "string" && b.name !== before.name)
                    db().run("UPDATE patients SET status=? WHERE status=?", [b.name, before.name]);
            });
        }
        catch (e) {
            if (/UNIQUE/.test(String(e?.message)))
                throw new HttpError(409, `${L.label} already exists`);
            throw e;
        }
        audit(req, "admin.lookup.update", L.table, id, { before, after: b });
        return db().get(`SELECT ${L.select} FROM ${L.table} WHERE id=?`, [id]);
    });
    app.delete("/lookups/:kind/:id", async (req) => {
        const { kind, id } = parse(z.object({ kind: zKind, id: zId }), req.params);
        const L = LOOKUPS[kind];
        const before = db().get(`SELECT ${L.select} FROM ${L.table} WHERE id=?`, [id]);
        if (!before)
            throw notFound(L.label);
        if (kind === "statuses") {
            const n = db().get("SELECT COUNT(*) c FROM patients WHERE active=1 AND status=?", [before.name]).c;
            if (n)
                throw new HttpError(409, `The status is used by ${n} active patient(s) — change their status first`);
        }
        db().run(`DELETE FROM ${L.table} WHERE id=?`, [id]);
        audit(req, "admin.lookup.delete", L.table, id, before);
        return { ok: true };
    });
    /* ======== Settings ======== */
    app.get("/settings", async () => allSettings());
    app.get("/settings/schema", async () => settingsSchema());
    /** Admin → Features (release 1.11): every feature since 1.4 with its switch; changed through PUT /settings. */
    app.get("/features", async () => {
        const on = featureStates();
        return { features: FEATURES.map((f) => ({ key: f.key, n: f.n, release: f.release, name: f.name, description: f.description,
                default: f.default, setting: featureSettingKey(f), on: on[f.key] })), alwaysOn: ALWAYS_ON };
    });
    app.put("/settings", async (req) => {
        const b = parse(SETTINGS_BODY, req.body);
        const merged = { ...allSettings(), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
        const problem = crossCheck(merged);
        if (problem)
            throw new HttpError(400, problem);
        const changed = {};
        db().tx(() => {
            for (const [k, v] of Object.entries(b)) {
                if (v === undefined)
                    continue;
                const prev = db().get("SELECT value FROM settings WHERE key=?", [k])?.value;
                if (prev === v)
                    continue;
                db().run("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
                changed[k] = { from: prev ?? null, to: v };
            }
        });
        if (Object.keys(changed).length) {
            audit(req, "admin.settings.update", "settings", null, changed);
            if ("backup.interval_hours" in changed)
                restartBackupSchedule();
        }
        return allSettings();
    });
    /** Reset keys to their defaults (body: { keys: [...] }, or {} for every editable key). */
    app.post("/settings/reset", async (req) => {
        const { keys } = parse(z.object({ keys: z.array(z.string()).max(200).optional() }), req.body ?? {});
        const targets = (keys ?? SETTINGS_KEYS_EDITABLE).filter((k) => SETTINGS_KEYS_EDITABLE.includes(k));
        const changed = {};
        db().tx(() => {
            for (const k of targets) {
                const prev = db().get("SELECT value FROM settings WHERE key=?", [k])?.value;
                if (prev == null)
                    continue;
                db().run("DELETE FROM settings WHERE key=?", [k]);
                changed[k] = { from: prev, to: "(default)" };
            }
            // Resetting only some keys can leave a pair the save would refuse (e.g. low cover ≤ critical cover); roll back.
            const problem = crossCheck(allSettings());
            if (problem)
                throw new HttpError(400, problem);
        });
        if (Object.keys(changed).length) {
            audit(req, "admin.settings.reset", "settings", null, changed);
            if ("backup.interval_hours" in changed)
                restartBackupSchedule();
        }
        return allSettings();
    });
    /* ======== Backups ======== */
    app.get("/backups", async () => {
        const last = db().get("SELECT at, action, details FROM audit_log WHERE action IN ('backup.auto','admin.backup.create') ORDER BY id DESC LIMIT 1");
        let lastRun = null;
        if (last) {
            let d = {};
            try {
                d = JSON.parse(last.details ?? "{}");
            }
            catch { /* ignore */ }
            lastRun = { at: last.at, ok: d.ok !== false, error: d.error, auto: last.action === "backup.auto" };
        }
        const cdir = copyDir();
        return { dir: backupDir(), keepDays: keepDays(), files: listBackups(), lastRun, inMemory: db().file === ":memory:",
            copyDir: cdir, copyDirReachable: cdir ? await dirExists(cdir) : null, checks: recentChecks(20) };
    });
    app.post("/backups", async (req) => {
        let r;
        try {
            r = runBackup();
        }
        catch (e) {
            audit(req, "admin.backup.create", "backup", null, { ok: false, error: String(e?.message ?? e) });
            throw new HttpError(500, `Could not create the backup: ${String(e?.message ?? e)}`);
        }
        // opened again, checked and copied to the second place
        // checked and copied unless that is switched off (Admin → Features)
        const check = featureOn("backup_checks") ? await checkAndCopy(r.file, "manual") : null;
        audit(req, "admin.backup.create", "backup", r.name, { ok: true, size: r.size, ms: r.ms, pruned: r.pruned, checked: check?.ok ?? null, copied: check?.copyOk ?? null });
        return { name: r.name, size: r.size, ms: r.ms, pruned: r.pruned, check };
    });
    /** Test a restore: opens the backup as a restore would (with this database's key), checks every page and counts the main tables. Changes nothing. */
    app.post("/backups/:name/test", async (req) => {
        const { name } = parse(z.object({ name: z.string().regex(BACKUP_RE, "Invalid file name") }), req.params);
        const file = join(backupDir(), name);
        if (!existsSync(file))
            throw notFound("Backup file");
        const check = await checkAndCopy(file, "restore_test");
        audit(req, "admin.backup.restore_test", "backup", name, { ok: check.ok, error: check.error });
        return check;
    });
    app.get("/backups/:name/download", async (req, reply) => {
        const { name } = parse(z.object({ name: z.string().regex(BACKUP_RE, "Invalid file name") }), req.params);
        const file = join(backupDir(), name);
        if (!existsSync(file))
            throw notFound("Backup file");
        audit(req, "admin.backup.download", "backup", name);
        reply.header("Content-Type", "application/vnd.sqlite3");
        reply.header("Content-Length", statSync(file).size);
        reply.header("Content-Disposition", `attachment; filename="${name}"`);
        return reply.send(createReadStream(file));
    });
    /* ======== Audit log ======== */
    app.get("/audit", async (req) => {
        const q = parse(z.object({
            userId: zId.optional(),
            action: z.string().trim().max(60).optional(),
            entity: z.string().trim().max(60).optional(),
            from: zDate.optional(),
            to: zDate.optional(),
            page: z.coerce.number().int().min(1).default(1),
            pageSize: z.coerce.number().int().min(10).max(200).default(50),
        }), req.query);
        const where = [];
        const params = [];
        if (q.userId) {
            where.push("a.user_id = ?");
            params.push(q.userId);
        }
        if (q.action) {
            where.push("substr(a.action, 1, length(?)) = ?");
            params.push(q.action, q.action);
        }
        if (q.entity) {
            where.push("a.entity = ?");
            params.push(q.entity);
        }
        if (q.from) {
            where.push("a.at >= ?");
            params.push(q.from);
        }
        if (q.to) {
            where.push("a.at < date(?, '+1 day')");
            params.push(q.to);
        }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = db().get(`SELECT COUNT(*) c FROM audit_log a ${w}`, params).c;
        const rows = db().all(`SELECT a.id, a.at, a.user_id AS userId, u.display_name AS userName, u.username, a.location_id AS locationId, l.name AS locationName,
              a.action, a.entity, a.entity_id AS entityId, a.details
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN locations l ON l.id=a.location_id
       ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
        return { rows, total, page: q.page, pageSize: q.pageSize };
    });
    /** Distinct actions and entities, for the filter pickers. */
    app.get("/audit/facets", async () => ({
        actions: db().all("SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY action"),
        entities: db().all("SELECT entity, COUNT(*) AS count FROM audit_log WHERE entity IS NOT NULL GROUP BY entity ORDER BY entity").map((r) => r.entity),
    }));
    /* ======== System health ======== */
    app.get("/health", async () => healthReport());
    app.post("/health/check-database", async (req) => {
        const r = checkDatabase();
        audit(req, "admin.health.check_database", "database", undefined, r);
        return r;
    });
    /* ======== System ======== */
    app.get("/system", async () => {
        const d = db();
        const file = d.file === ":memory:" ? ":memory:" : resolve(process.cwd(), d.file);
        const size = (p) => { try {
            return statSync(p).size;
        }
        catch {
            return 0;
        } };
        const tables = d.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        // Table names come from sqlite_master (not user input); quote defensively anyway.
        const counts = tables.map(({ name }) => ({ table: name, rows: d.get(`SELECT COUNT(*) c FROM "${name.replace(/"/g, '""')}"`).c }));
        const backups = listBackups();
        return {
            appVersion: appVersion(),
            nodeVersion: process.version,
            serverTime: nowIso(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            tzEnv: process.env.TZ ?? null,
            uptimeSec: Math.round(process.uptime()),
            dbFile: file,
            dbSize: file === ":memory:" ? 0 : size(file),
            walSize: file === ":memory:" ? 0 : size(`${file}-wal`),
            counts,
            lastBackup: backups[0] ?? null,
            backupCount: backups.length,
            legacyImportAt: d.get("SELECT value FROM schema_meta WHERE key='legacy_import_at'")?.value ?? null,
        };
    });
}
