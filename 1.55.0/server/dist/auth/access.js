// What a signed-in user may do: their role (core/permissions.ts) read from the roles table.
import { db } from "../db/index.js";
import { BUILTIN_ROLES, LEGACY_ROLE, PERMISSIONS, parsePerms } from "../core/permissions.js";
const ALL = new Set(PERMISSIONS.map((p) => p.key));
/**
 * The access of a user row (users.role and users.role_id). A user without a role (written before roles existed, or by
 * an older PC) gets the built-in role matching their level; a role that no longer exists gives no permissions.
 */
export function accessOf(u) {
    const r = u.role_id != null
        ? db().get("SELECT id, key, name, permissions FROM roles WHERE id = ?", [u.role_id])
        : db().get("SELECT id, key, name, permissions FROM roles WHERE key = ?", [LEGACY_ROLE[u.role] ?? "viewer"]);
    if (!r) {
        if (u.role_id != null)
            return { roleId: u.role_id, roleName: "No role", owner: false, perms: new Set() };
        const b = BUILTIN_ROLES.find((x) => x.key === (LEGACY_ROLE[u.role] ?? "viewer"));
        return { roleId: null, roleName: b.name, owner: false, perms: new Set(b.permissions) };
    }
    if (r.key === "owner")
        return { roleId: r.id, roleName: r.name, owner: true, perms: ALL };
    return { roleId: r.id, roleName: r.name, owner: false, perms: new Set(parsePerms(r.permissions)) };
}
/** The roles table's id of a built-in role. */
export const builtinRoleId = (key) => db().get("SELECT id FROM roles WHERE key = ?", [key])?.id ?? null;
