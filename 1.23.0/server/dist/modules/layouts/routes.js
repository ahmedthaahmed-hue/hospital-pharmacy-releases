import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, parse, requirePerm, zId } from "../../lib/http.js";
import { nowIso } from "../../lib/time.js";
import { settingBool } from "../../core/settings.js";
/** screen:workspace, nav, table:patients, parts:order-form (the items inside a panel, release 1.23), label:rptMedicationLabel … */
export const zLayoutKey = z.string().regex(/^(nav|(screen|table|parts|label):[A-Za-z0-9_-]{1,40})$/, "Unknown layout");
const MAX_BYTES = 64 * 1024;
/** Personal layouts one user may keep (every screen, table and the sidebar fit many times over). */
export const MAX_PER_USER = 300;
const zData = z.record(z.string(), z.unknown()).refine((o) => JSON.stringify(o).length <= MAX_BYTES, "This layout is too large");
const BODY = z.object({ data: zData });
/** Labels are printed for patients: they are arranged for a pharmacy or the hospital, never per user. */
const isLabel = (key) => key.startsWith("label:");
const parseRows = (rows) => {
    const out = {};
    for (const r of rows) {
        try {
            out[r.key] = JSON.parse(r.data);
        }
        catch { /* skip a damaged row */ }
    }
    return out;
};
const SELECT = `SELECT scope, scope_id AS scopeId, key, data, updated_at AS updatedAt FROM ui_layouts`;
function save(req, scope, scopeId, key, data) {
    db().run(`INSERT INTO ui_layouts(scope, scope_id, key, data, updated_at, updated_by) VALUES (?,?,?,?,?,?)
            ON CONFLICT(scope, scope_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, [scope, scopeId, key, JSON.stringify(data), nowIso(), req.ctx.userId]);
}
function remove(scope, scopeId, key) {
    return key ? db().run("DELETE FROM ui_layouts WHERE scope = ? AND scope_id = ? AND key = ?", [scope, scopeId, key]).changes
        : db().run("DELETE FROM ui_layouts WHERE scope = ? AND scope_id = ?", [scope, scopeId]).changes;
}
/** /api/layouts: what this user sees, and their own arrangements. */
export default async function routes(app) {
    app.get("/", async (req) => {
        const rows = db().all(`${SELECT} WHERE (scope = 'hospital' AND scope_id = 0) OR (scope = 'location' AND scope_id = ?) OR (scope = 'user' AND scope_id = ?)`, [req.ctx.locationId, req.ctx.userId]);
        return {
            hospital: parseRows(rows.filter((r) => r.scope === "hospital")),
            location: parseRows(rows.filter((r) => r.scope === "location")),
            user: parseRows(rows.filter((r) => r.scope === "user")),
            locked: settingBool("ui.lock_layouts"),
        };
    });
    // Personal layouts are each user's own screen arrangement, viewers included (it changes nothing anyone else sees).
    // (Work replayed from a pharmacy PC was checked there, as the user it really is: admins replay as pharmacists.)
    const mine = (req) => {
        if (settingBool("ui.lock_layouts") && !can(req.ctx, "layouts.shared") && req.ctx.token !== "replay")
            throw new HttpError(403, "An admin has locked the layouts");
    };
    app.put("/mine/:key", async (req) => {
        mine(req);
        const key = parse(zLayoutKey, req.params.key);
        if (isLabel(key))
            throw new HttpError(400, "Labels are arranged for a pharmacy or the whole hospital, not for one user");
        const { data } = parse(BODY, req.body);
        const have = db().get("SELECT COUNT(*) AS n, SUM(key = ?) AS mine FROM ui_layouts WHERE scope = 'user' AND scope_id = ?", [key, req.ctx.userId]);
        if (have && have.n >= MAX_PER_USER && !have.mine)
            throw new HttpError(409, "Too many saved layouts — reset some of your own layouts first");
        save(req, "user", req.ctx.userId, key, data);
        return { ok: true };
    });
    app.delete("/mine/:key", async (req) => {
        const key = parse(zLayoutKey, req.params.key);
        return { ok: true, removed: remove("user", req.ctx.userId, key) };
    });
    app.delete("/mine", async (req) => ({ ok: true, removed: remove("user", req.ctx.userId) }));
}
const zScope = z.enum(["hospital", "location"], "Choose the hospital or a pharmacy");
const scopeId = (scope, locationId) => {
    if (scope === "hospital")
        return 0;
    const id = parse(zId, locationId);
    if (!db().get("SELECT 1 FROM locations WHERE id = ?", [id]))
        throw new HttpError(404, "Pharmacy not found");
    return id;
};
/**
 * /api/admin/layouts (pharmacy PCs refuse admin writes): label designs need "Change the label designs", screen layouts
 * "Save screen layouts for a PC, a pharmacy or everyone"; the overview either.
 */
export async function adminLayoutRoutes(app) {
    app.addHook("preHandler", async (req) => {
        const key = req.params?.key;
        if (key !== undefined)
            return requirePerm(req, isLabel(key) ? "admin.labels" : "layouts.shared");
        if (req.method === "GET" && can(req.ctx, "admin.labels"))
            return;
        requirePerm(req, "layouts.shared");
    });
    /** Every saved layout, for the overview in the Settings Center (personal ones counted per user). */
    app.get("/", async () => db().all(`SELECT l.scope, l.scope_id AS scopeId, l.key, l.updated_at AS updatedAt, u.display_name AS updatedBy,
      CASE l.scope WHEN 'location' THEN (SELECT name FROM locations WHERE id = l.scope_id) WHEN 'user' THEN (SELECT display_name FROM users WHERE id = l.scope_id) END AS scopeName
    FROM ui_layouts l LEFT JOIN users u ON u.id = l.updated_by ORDER BY l.scope, l.scope_id, l.key`));
    app.put("/:scope/:key", async (req) => {
        const scope = parse(zScope, req.params.scope), key = parse(zLayoutKey, req.params.key);
        const id = scopeId(scope, req.query.locationId);
        const { data } = parse(BODY, req.body);
        save(req, scope, id, key, data);
        audit(req, "admin.layout.save", "ui_layouts", `${scope}:${id}:${key}`);
        return { ok: true };
    });
    app.delete("/:scope/:key", async (req) => {
        const scope = parse(zScope, req.params.scope), key = parse(zLayoutKey, req.params.key);
        const id = scopeId(scope, req.query.locationId);
        const removed = remove(scope, id, key);
        if (removed)
            audit(req, "admin.layout.reset", "ui_layouts", `${scope}:${id}:${key}`);
        return { ok: true, removed };
    });
    /** Remove every personal layout of one user (an admin tidying up), or of everyone (?all=1). */
    app.delete("/users", async (req) => {
        const removed = req.query.all === "1" ? db().run("DELETE FROM ui_layouts WHERE scope = 'user'").changes : remove("user", parse(zId, req.query.userId));
        audit(req, "admin.layout.reset_personal", "ui_layouts", req.query.all === "1" ? "all" : String(req.query.userId), { removed });
        return { ok: true, removed };
    });
}
