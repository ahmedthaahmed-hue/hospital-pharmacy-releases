import { z } from "zod";
import { db } from "../../db/index.js";
import { accessOf } from "../../auth/access.js";
import { audit, bad, HttpError, notFound, parse, requireOwner, zId } from "../../lib/http.js";
import { nowIso } from "../../lib/time.js";
import { NEW_ACCOUNT_ROLE, OWNER_ONLY, PERMISSIONS, PERMISSION_GROUPS, PERMISSION_KEYS, levelFor, parsePerms } from "../../core/permissions.js";
const role = (id) => db().get("SELECT id, key, name, description, permissions, sort FROM roles WHERE id = ?", [id]);
const permsOf = (r) => (r.key === "owner" ? PERMISSIONS.map((p) => p.key) : parsePerms(r.permissions));
/** May this user give role `r`: the owner any; others a role whose permissions are all their own, never the owner role. */
function mayGive(req, r) {
    if (req.ctx.owner)
        return true;
    return r.key !== "owner" && permsOf(r).every((p) => req.ctx.perms.has(p));
}
/** The role a user is to be given (by id, or by the old level names), checked against what the giver may give. */
export function roleToGive(req, b) {
    const r = b.roleId != null ? role(b.roleId)
        : b.role ? db().get("SELECT id, key, name, description, permissions, sort FROM roles WHERE key = ?", [NEW_ACCOUNT_ROLE[b.role] ?? b.role]) : undefined;
    if (!r)
        throw bad("Choose the user's role");
    if (!mayGive(req, r))
        throw new HttpError(403, r.key === "owner" ? "Only the owner can give the owner role" : "You cannot give a role with permissions you do not have");
    return { id: r.id, level: levelFor(permsOf(r)) };
}
/**
 * May this user change account `u` (edit, deactivate, reset its password, its badge or two-step sign-in, end its
 * sessions)? Without "Work in any pharmacy" only accounts whose home is the pharmacy one works as (the same rule as
 * `assertHomePharmacy`): an account with no home pharmacy, or another one, could work anywhere, and whoever resets its
 * password could sign in as it.
 */
export function assertMayManage(req, u) {
    if (req.ctx.owner || u.id === req.ctx.userId)
        return;
    const a = accessOf(u);
    if (a.owner)
        throw new HttpError(403, "Only the owner can change the owner's account");
    if ([...a.perms].some((p) => !req.ctx.perms.has(p)))
        throw new HttpError(403, "This account has permissions you do not have — ask the owner");
    if (!req.ctx.perms.has("pharmacies.all") && (u.location_id == null || u.location_id !== req.ctx.locationId))
        throw new HttpError(403, "This account belongs to another pharmacy (or to none) — ask someone who works in every pharmacy");
}
/**
 * The home pharmacy an account may be given: without "Work in any pharmacy" only the pharmacy one works as (an account
 * with no home pharmacy, or another one, could work anywhere).
 */
export function assertHomePharmacy(req, locationId) {
    if (req.ctx.owner || req.ctx.perms.has("pharmacies.all"))
        return;
    if (locationId !== req.ctx.locationId)
        throw new HttpError(403, "You can give only your own pharmacy as the home pharmacy");
}
/** Is user `id` the last active owner (who must not lose the role or be deactivated)? */
export function isLastOwner(id) {
    const owners = db().all("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'owner' AND u.active = 1");
    return owners.length === 1 && owners[0].id === id;
}
const zPerms = z.array(z.string()).max(PERMISSIONS.length * 2)
    .transform((a) => [...new Set(a)])
    .refine((a) => a.every((p) => PERMISSION_KEYS.has(p)), "Unknown permission");
const zRoleName = z.string().trim().min(2, "Give the role a name").max(60, "The name is too long");
export async function roleRoutes(app) {
    const list = (req) => db().all(`SELECT r.id, r.key, r.name, r.description, r.permissions, r.sort,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.active = 1) AS users
     FROM roles r ORDER BY r.key IS NULL, r.sort, r.name`).map((r) => ({
        id: r.id, key: r.key, name: r.name, description: r.description, builtin: r.key != null, owner: r.key === "owner",
        permissions: permsOf(r), users: r.users, canGive: mayGive(req, r),
    }));
    app.get("/", async (req) => list(req));
    app.get("/catalog", async () => ({ groups: PERMISSION_GROUPS, permissions: PERMISSIONS, ownerOnly: OWNER_ONLY }));
    app.post("/", async (req) => {
        requireOwner(req);
        const b = parse(z.object({ name: zRoleName, description: z.string().trim().max(200).nullish(), permissions: zPerms }), req.body);
        if (db().get("SELECT 1 FROM roles WHERE name = ?", [b.name]))
            throw new HttpError(409, "A role with this name already exists");
        const sort = (db().get("SELECT MAX(sort) AS s FROM roles")?.s ?? 0) + 1;
        const r = db().run("INSERT INTO roles(name, description, permissions, sort, created_at, updated_at) VALUES (?,?,?,?,?,?)", [b.name, b.description || null, JSON.stringify(b.permissions), sort, nowIso(), nowIso()]);
        audit(req, "admin.role.create", "role", r.lastId, b);
        return list(req).find((x) => x.id === r.lastId);
    });
    app.patch("/:id", async (req) => {
        requireOwner(req);
        const id = parse(z.object({ id: zId }), req.params).id;
        const b = parse(z.object({ name: zRoleName.optional(), description: z.string().trim().max(200).nullish(), permissions: zPerms.optional() }), req.body);
        return db().tx(() => {
            const r = role(id);
            if (!r)
                throw notFound("Role");
            if (r.key === "owner")
                throw bad("The owner role always has every permission and cannot be changed");
            if (b.name && db().get("SELECT 1 FROM roles WHERE name = ? AND id <> ?", [b.name, id]))
                throw new HttpError(409, "A role with this name already exists");
            const perms = b.permissions ?? parsePerms(r.permissions);
            db().run("UPDATE roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?", [b.name ?? r.name, b.description === undefined ? r.description : b.description || null, JSON.stringify(perms), nowIso(), id]);
            // the coarse level of its users follows (permissions themselves are read at every request)
            db().run("UPDATE users SET role = ? WHERE role_id = ?", [levelFor(perms), id]);
            audit(req, "admin.role.update", "role", id, b);
            return list(req).find((x) => x.id === id);
        });
    });
    app.delete("/:id", async (req) => {
        requireOwner(req);
        const id = parse(z.object({ id: zId }), req.params).id;
        const r = role(id);
        if (!r)
            throw notFound("Role");
        if (r.key)
            throw bad("Built-in roles cannot be deleted (change their permissions instead)");
        const n = db().get("SELECT COUNT(*) c FROM users WHERE role_id = ?", [id]).c;
        if (n)
            throw new HttpError(409, `${n} ${n === 1 ? "account has" : "accounts have"} this role — give them another role first`);
        db().run("DELETE FROM roles WHERE id = ?", [id]);
        audit(req, "admin.role.delete", "role", id, { name: r.name });
        return { ok: true };
    });
}
