import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dataPath } from "../platform/paths.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, parse, audit } from "../lib/http.js";
import { nowIso, toLocalIso } from "../lib/time.js";
import { hashPassword, verifyPassword, checkUserPassword } from "./passwords.js";
import { internalCtx } from "../platform/hub.js";
import { nodeConfig } from "../platform/node-config.js";
import { settingNum, settingStr } from "../core/settings.js";
import { throttledCheck } from "../lib/rate-limit.js";
export const COOKIE = "hps_session";
export function loadSession(token) {
    if (!token)
        return null;
    const s = db().get(`SELECT s.token, s.location_id, s.expires_at, u.id, u.username, u.display_name, u.role, u.active, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]);
    if (!s || !s.active || s.expires_at < nowIso())
        return null;
    return { token: s.token, userId: s.id, username: s.username, displayName: s.display_name, role: s.role, locationId: s.location_id,
        mustChangePassword: !!s.must_change_password };
}
export async function authRoutes(app) {
    app.post("/login", async (req, reply) => {
        const body = parse(z.object({ username: z.string().trim().min(1), password: z.string().min(1).max(200), locationId: z.coerce.number().int().optional() }), req.body);
        const u = db().get("SELECT * FROM users WHERE username = ? AND active = 1", [body.username]);
        if (!throttledCheck("login", req.ip, body.username, () => checkUserPassword(body.password, u?.password_hash)))
            throw new HttpError(401, "Wrong username or password");
        let loc = u.location_id;
        const isActive = (id) => !!db().get("SELECT 1 FROM locations WHERE id=? AND active=1", [id]);
        // A stale choice (the login screen remembers the last pharmacy) that is now stopped or deleted is ignored.
        if (body.locationId && (u.role === "admin" || !loc) && isActive(body.locationId))
            loc = body.locationId;
        // A stopped pharmacy cannot be worked as (stopping it ends its sessions): admins fall back to an active one,
        // users pinned to it are refused until an admin moves them.
        if (loc && !isActive(loc)) {
            if (u.role !== "admin")
                throw new HttpError(403, "Your pharmacy is inactive — contact the system admin");
            loc = null;
        }
        // On a pharmacy PC, its own pharmacy: work done there as another one is refused when it reaches the main server.
        const pcLoc = nodeConfig().role === "pharmacy" ? nodeConfig().locationId : undefined;
        if (!loc && pcLoc && isActive(pcLoc))
            loc = pcLoc;
        if (!loc)
            loc = db().get("SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1")?.id;
        if (!loc)
            throw new HttpError(400, "No pharmacies are set up");
        const token = randomBytes(32).toString("hex");
        const exp = new Date(Date.now() + settingNum("auth.session_hours") * 3600_000); // default 14 h: one long shift
        db().run("INSERT INTO sessions(token,user_id,location_id,created_at,expires_at) VALUES (?,?,?,?,?)", [token, u.id, loc, nowIso(), toLocalIso(exp)]);
        db().run("UPDATE users SET last_login_at=? WHERE id=?", [nowIso(), u.id]);
        db().run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
        reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "strict", expires: exp });
        req.ctx = loadSession(token);
        audit(req, "auth.login");
        return me(req);
    });
    /** Public (pre-login) branding for the sign-in screen: names, message and the hospital-wide look. */
    app.get("/branding", async () => ({
        hospitalName: settingStr("hospital.name"), subtitle: settingStr("hospital.subtitle"), loginMessage: settingStr("auth.login_message"),
        theme: settingStr("ui.theme"), accent: settingStr("ui.accent"), font: settingStr("ui.font"),
        server: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() },
    }));
    app.post("/logout", async (req, reply) => {
        const token = req.cookies[COOKIE];
        if (token)
            db().run("DELETE FROM sessions WHERE token=?", [token]);
        reply.clearCookie(COOKIE, { path: "/" });
        return { ok: true };
    });
    app.get("/me", async (req) => {
        const ctx = loadSession(req.cookies[COOKIE]);
        if (!ctx)
            throw new HttpError(401, "Please sign in");
        req.ctx = ctx;
        return me(req);
    });
    /** Switch the pharmacy this session works as. Admins: any; others: only their home location (or any if none set). */
    app.post("/location", async (req) => {
        const ctx = loadSession(req.cookies[COOKIE]);
        if (!ctx)
            throw new HttpError(401, "Please sign in");
        req.ctx = ctx;
        const { locationId } = parse(z.object({ locationId: z.coerce.number().int() }), req.body);
        const home = db().get("SELECT location_id FROM users WHERE id=?", [ctx.userId])?.location_id;
        if (ctx.role !== "admin" && home && home !== locationId)
            throw new HttpError(403, "You cannot work as another pharmacy");
        if (!db().get("SELECT 1 FROM locations WHERE id=? AND active=1", [locationId]))
            throw new HttpError(404, "Pharmacy not found");
        db().run("UPDATE sessions SET location_id=? WHERE token=?", [locationId, ctx.token]);
        req.ctx.locationId = locationId;
        audit(req, "auth.switch_location", "location", locationId);
        return me(req);
    });
    app.post("/password", async (req) => {
        // A password changed on a pharmacy PC is replayed here as that user (platform/hub.ts).
        const ctx = internalCtx(req) ?? loadSession(req.cookies[COOKIE]);
        if (!ctx)
            throw new HttpError(401, "Please sign in");
        req.ctx = ctx;
        const min = settingNum("auth.password_min");
        const b = parse(z.object({ current: z.string().max(200), next: z.string().min(min, `Password must be at least ${min} characters`).max(200) }), req.body);
        const u = db().get("SELECT password_hash FROM users WHERE id=?", [ctx.userId]);
        if (!throttledCheck("password", req.ip, ctx.username, () => verifyPassword(b.current, u.password_hash)))
            throw new HttpError(400, "Current password is wrong");
        if (b.next === b.current)
            throw new HttpError(400, "Choose a new password different from the current one");
        db().run("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?", [hashPassword(b.next), ctx.userId]);
        // a new password ends every other session of this user (this one stays signed in)
        db().run("DELETE FROM sessions WHERE user_id=? AND token<>?", [ctx.userId, ctx.token]);
        audit(req, "auth.change_password");
        // the first admin's generated password is no longer needed once they chose their own
        if (ctx.role === "admin")
            rmSync(dataPath("first-admin-password.txt"), { force: true });
        return { ok: true };
    });
    /** Public: locations for the login screen. */
    app.get("/locations", async () => db().all("SELECT id, name FROM locations WHERE active=1 ORDER BY id"));
}
function me(req) {
    const c = req.ctx;
    const loc = db().get("SELECT id, name FROM locations WHERE id=?", [c.locationId]);
    const u = db().get("SELECT location_id, must_change_password FROM users WHERE id=?", [c.userId]);
    return { id: c.userId, username: c.username, displayName: c.displayName, role: c.role, location: loc, homeLocationId: u?.location_id ?? null, mustChangePassword: !!u?.must_change_password };
}
