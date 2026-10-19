import { featureOn } from "../core/feature-gate.js";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dataPath } from "../platform/paths.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, parse, audit } from "../lib/http.js";
import { nowIso, toLocalIso } from "../lib/time.js";
import { hashPassword, verifyPassword, checkUserPassword } from "./passwords.js";
import { accessOf } from "./access.js";
import { matchCode, matchRecovery, newRecoveryCodes, newSecret, otpauthUri } from "./totp.js";
import { CODE_LOCK_MINUTES, CODE_TRIES, PIN_TRIES } from "./limits.js";
import { internalCtx } from "../platform/hub.js";
import { nodeConfig } from "../platform/node-config.js";
import { settingBool, settingNum, settingStr } from "../core/settings.js";
import { throttledCheck } from "../lib/rate-limit.js";
export const COOKIE = "hps_session";
export function loadSession(token) {
    if (!token)
        return null;
    const s = db().get(`SELECT s.token, s.location_id, s.expires_at, s.locked_at, s.last_seen_at, s.created_at AS session_at, u.id, u.username, u.display_name, u.role, u.role_id, u.active, u.must_change_password, u.totp_enabled
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]);
    if (!s || !s.active || s.expires_at < nowIso())
        return null;
    // the idle lock is the server's too: a browser closed, asleep or hung leaves its session to lock here
    // (last_seen_at: the screen's activity, POST /auth/activity; not background polling)
    const idle = settingNum("auth.idle_lock_minutes");
    const lockOn = featureOn("screen_lock"); // switched off (Admin → Features): screens never lock
    if (lockOn && !s.locked_at && idle > 0 && (s.last_seen_at ?? s.session_at) < toLocalIso(new Date(Date.now() - idle * 60_000))) {
        s.locked_at = toLocalIso(new Date());
        db().untracked(() => db().run("UPDATE sessions SET locked_at = ? WHERE token = ?", [s.locked_at, s.token]));
    }
    const access = accessOf(s);
    return { token: s.token, userId: s.id, username: s.username, displayName: s.display_name, role: s.role, locationId: s.location_id,
        mustChangePassword: !!s.must_change_password, locked: lockOn && !!s.locked_at,
        mustEnrollTotp: !s.totp_enabled && totpRequiredFor(access), ...access };
}
/** Two-step sign-in is required for this role (setting auth.totp_admins; set up on the main server only). */
export function totpRequiredFor(a) {
    return nodeConfig().role !== "pharmacy" && featureOn("two_step") && settingBool("auth.totp_admins") && (a.owner || [...a.perms].some((p) => p.startsWith("admin.")));
}
/**
 * What a signed-in session must do before anything else: replace a temporary password, set up two-step sign-in when
 * required, and unlock a locked screen. Enforced on the API (app.ts, and the routes outside it), not only in the UI.
 */
export function sessionGate(ctx) {
    if (ctx.mustChangePassword)
        throw new HttpError(403, "Change your temporary password first", { code: "must_change_password" });
    if (ctx.locked)
        throw new HttpError(423, "The screen is locked", { code: "screen_locked" });
    if (ctx.mustEnrollTotp)
        throw new HttpError(403, "Set up two-step sign-in first", { code: "must_enroll_totp" });
}
export async function authRoutes(app) {
    await moreAuthRoutes(app);
    app.post("/login", async (req, reply) => {
        const body = parse(z.object({ username: z.string().trim().min(1), password: z.string().min(1).max(200), locationId: z.coerce.number().int().optional() }), req.body);
        const u = db().get("SELECT * FROM users WHERE username = ? AND active = 1", [body.username]);
        if (!throttledCheck("login", req.ip, body.username, () => checkUserPassword(body.password, u?.password_hash)))
            throw new HttpError(401, "Wrong username or password");
        // two-step sign-in: the password was right; the session starts once the code from their phone is right too
        // (two-step sign-in switched off in Admin → Features: the password alone, also for users who had it on)
        // (with two-step switched off, users who already have it keep using it: switching a feature off must not take
        // away someone's second factor)
        const twoStep = true;
        if (twoStep && u.totp_enabled && u.totp_secret)
            return { twoStep: true, ticket: newTicket(u.id, body.locationId) };
        // a pharmacy PC's copy keeps no second-step secrets of administrators or of other pharmacies' users (hub.ts)
        if (twoStep && u.totp_enabled)
            throw new HttpError(403, "This account uses two-step sign-in: sign in on the main server", { code: "use_main_server" });
        return startSession(req, reply, u, body.locationId);
    });
    /** Second step: the 6-digit code from the authenticator app, or one of the recovery codes. */
    app.post("/login/code", async (req, reply) => {
        const b = parse(z.object({ ticket: z.string().min(10).max(100), code: z.string().trim().min(6).max(20) }), req.body);
        const t = tickets.get(b.ticket);
        if (!t || t.exp < Date.now()) {
            tickets.delete(b.ticket);
            throw new HttpError(401, "This sign-in has expired — sign in again");
        }
        const u = db().get("SELECT * FROM users WHERE id = ? AND active = 1", [t.userId]);
        // (two-step sign-in turned off or reset meanwhile: start again)
        if (!u || !u.totp_enabled || !u.totp_secret) {
            tickets.delete(b.ticket);
            throw new HttpError(401, "Sign in again");
        }
        const ok = throttledCheck("login", req.ip, u.username, () => useSecondFactor(u, b.code));
        if (!ok) {
            if (++t.tries >= 5)
                tickets.delete(b.ticket);
            throw new HttpError(401, "The code is wrong — use the newest code from the app");
        }
        tickets.delete(b.ticket);
        return startSession(req, reply, u, t.locationId);
    });
    /** Badge and PIN: scan the badge (Admin → Users → Print badge), type the PIN. */
    app.post("/badge", async (req, reply) => {
        const b = parse(z.object({ badge: z.string().trim().min(6).max(64), pin: z.string().trim().min(1).max(12), locationId: z.coerce.number().int().optional() }), req.body);
        if (!settingBool("auth.badge_login"))
            throw new HttpError(403, "Signing in with a badge is turned off");
        const u = db().get("SELECT * FROM users WHERE badge_code = ? AND active = 1", [b.badge.toUpperCase()]);
        const key = `badge:${b.badge.toUpperCase()}`;
        if (!throttledCheck("login", req.ip, key, () => checkPin(u, b.pin)))
            throw new HttpError(401, "Wrong badge or PIN");
        // an administrator with two-step sign-in uses it: a badge and a PIN are one factor
        if (u.totp_enabled)
            throw new HttpError(403, "Sign in with your username, password and code");
        // switching user at a locked screen: the locked session ends
        const old = req.cookies[COOKIE];
        if (old)
            db().run("DELETE FROM sessions WHERE token = ?", [old]);
        return startSession(req, reply, u, b.locationId);
    });
    /** Someone is using this screen (keys, mouse, touch; at most about once a minute): it is not idle. */
    app.post("/activity", async (req) => {
        const ctx = signedInCtx(req, { enrolling: true });
        db().untracked(() => db().run("UPDATE sessions SET last_seen_at = ? WHERE token = ?", [toLocalIso(new Date()), ctx.token]));
        return { ok: true };
    });
    /** Lock this session's screen (idle, or the lock button). */
    app.post("/lock", async (req) => {
        const ctx = loadSession(req.cookies[COOKIE]);
        if (!ctx)
            throw new HttpError(401, "Please sign in");
        if (ctx.mustChangePassword)
            throw new HttpError(403, "Change your temporary password first", { code: "must_change_password" });
        db().run("UPDATE sessions SET locked_at = COALESCE(locked_at, ?) WHERE token = ?", [nowIso(), ctx.token]);
        return { ok: true };
    });
    /** Unlock with the same person's password or PIN. Someone else signs in instead (the locked session then ends). */
    app.post("/unlock", async (req) => {
        const ctx = loadSession(req.cookies[COOKIE]);
        if (!ctx)
            throw new HttpError(401, "Please sign in");
        if (ctx.mustChangePassword)
            throw new HttpError(403, "Change your temporary password first", { code: "must_change_password" });
        const b = parse(z.object({ password: z.string().max(200).optional(), pin: z.string().max(12).optional() }), req.body);
        const u = db().get("SELECT id, password_hash, pin_hash, pin_failures FROM users WHERE id = ?", [ctx.userId]);
        const ok = throttledCheck("login", req.ip, ctx.username, () => (b.pin ? checkPin(u, b.pin) : checkUserPassword(b.password ?? "", u?.password_hash)));
        if (!ok) {
            // PIN guessed at too often: it is turned off, and this locked session ends (the password signs in again)
            if (b.pin && u?.pin_hash && !db().get("SELECT 1 FROM users WHERE id = ? AND pin_hash IS NOT NULL", [ctx.userId])) {
                db().run("DELETE FROM sessions WHERE token = ?", [ctx.token]);
                throw new HttpError(401, "Too many wrong PINs: the PIN is turned off — sign in with your password");
            }
            throw new HttpError(401, b.pin ? "Wrong PIN" : "Wrong password");
        }
        db().run("UPDATE sessions SET locked_at = NULL, last_seen_at = ? WHERE token = ?", [nowIso(), ctx.token]);
        req.ctx = { ...ctx, locked: false };
        return me(req);
    });
    /** The user's PIN (4 to 8 digits) for unlocking and badge sign-in; null removes it. Needs their password. */
    app.post("/pin", async (req) => {
        const ctx = signedInCtx(req);
        mainServerOnly();
        const b = parse(z.object({ password: z.string().max(200), pin: z.string().regex(/^\d{4,8}$/, "The PIN is 4 to 8 digits").nullable() }), req.body);
        checkOwnPassword(req, ctx, b.password);
        db().run("UPDATE users SET pin_hash = ?, pin_failures = 0 WHERE id = ?", [b.pin ? hashPassword(b.pin) : null, ctx.userId]);
        audit(req, b.pin ? "auth.pin_set" : "auth.pin_removed");
        return { ok: true };
    });
    /** Start setting up two-step sign-in: a new secret for the authenticator app (not used until confirmed). */
    app.post("/totp/setup", async (req) => {
        const ctx = signedInCtx(req, { enrolling: true });
        mainServerOnly();
        const b = parse(z.object({ password: z.string().max(200) }), req.body);
        checkOwnPassword(req, ctx, b.password);
        const secret = newSecret();
        pendingSecrets.set(ctx.userId, { secret, exp: Date.now() + 15 * 60_000 });
        const issuer = settingStr("hospital.name") ? `Pharmacy — ${settingStr("hospital.name")}` : "Hospital Pharmacy";
        return { secret, uri: otpauthUri(secret, ctx.username, issuer) };
    });
    /** Confirm with a code from the app: two-step sign-in is on; the recovery codes are shown this once. */
    app.post("/totp/enable", async (req) => {
        const ctx = signedInCtx(req, { enrolling: true });
        mainServerOnly();
        const b = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
        const p = pendingSecrets.get(ctx.userId);
        if (!p || p.exp < Date.now())
            throw new HttpError(400, "Start again: the setup has expired");
        const step = matchCode(p.secret, b.code, Date.now(), null);
        if (step == null)
            throw new HttpError(400, "The code is wrong — check the phone's clock and type the newest code");
        const rec = newRecoveryCodes();
        db().run("UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery = ?, totp_last_step = ? WHERE id = ?", [p.secret, JSON.stringify(rec.hashes), step, ctx.userId]);
        pendingSecrets.delete(ctx.userId);
        audit(req, "auth.totp_enabled");
        return { recoveryCodes: rec.codes };
    });
    /** Turn two-step sign-in off (password and a current code). Refused while it is required for this user. */
    app.post("/totp/disable", async (req) => {
        const ctx = signedInCtx(req);
        mainServerOnly();
        const b = parse(z.object({ password: z.string().max(200), code: z.string().trim().min(6).max(20) }), req.body);
        if (totpRequiredFor(ctx))
            throw new HttpError(403, "Two-step sign-in is required for administrators here");
        checkOwnPassword(req, ctx, b.password);
        const u = db().get("SELECT * FROM users WHERE id = ?", [ctx.userId]);
        if (!u.totp_enabled || !throttledCheck("login", req.ip, ctx.username, () => useSecondFactor(u, b.code)))
            throw new HttpError(400, "The code is wrong");
        db().run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery = NULL, totp_last_step = NULL WHERE id = ?", [ctx.userId]);
        audit(req, "auth.totp_disabled");
        return { ok: true };
    });
    /** The user's own interface language (release 1.10); null: the hospital's default (Settings → Appearance). */
    app.post("/ui-lang", async (req) => {
        // chosen on a pharmacy PC: replayed here as that user (platform/hub.ts), so it holds on every PC
        const ctx = internalCtx(req) ?? signedInCtx(req, { enrolling: true });
        const b = parse(z.object({ lang: z.enum(["en", "ar"]).nullable() }), req.body);
        db().run("UPDATE users SET ui_lang = ? WHERE id = ?", [b.lang, ctx.userId]);
        return { ok: true, lang: b.lang };
    });
    /** The user has seen What's new up to this version. */
    app.post("/seen-version", async (req) => {
        const ctx = signedInCtx(req);
        const b = parse(z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }), req.body);
        db().run("UPDATE users SET seen_version = ? WHERE id = ?", [b.version, ctx.userId]);
        return { ok: true };
    });
}
/* ---- the pieces of signing in ---- */
/** Sign-ins waiting for their second step (in memory: a restart asks for the password again). */
const tickets = new Map();
function newTicket(userId, locationId) {
    for (const [k, t] of tickets)
        if (t.exp < Date.now())
            tickets.delete(k);
    const ticket = randomBytes(24).toString("hex");
    tickets.set(ticket, { userId, locationId, exp: Date.now() + 5 * 60_000, tries: 0 });
    return ticket;
}
/** Secrets being set up (shown, not confirmed yet). */
const pendingSecrets = new Map();
/**
 * A code from the app (each one once), or a recovery code (used up). True when it matched. Wrong codes are counted per
 * account (whatever the address): after CODE_TRIES in a row, codes are refused for CODE_LOCK_MINUTES.
 */
export function useSecondFactor(u, code) {
    if (u.totp_locked_until && u.totp_locked_until > nowIso())
        throw new HttpError(429, "Too many wrong codes: try again in a few minutes", { code: "codes_locked" });
    const ok = (() => {
        const step = matchCode(u.totp_secret, code, Date.now(), u.totp_last_step ?? null);
        if (step != null) {
            db().run("UPDATE users SET totp_last_step = ? WHERE id = ?", [step, u.id]);
            return true;
        }
        // recovery codes on the main server only: one used on a pharmacy PC would work again after its next copy
        if (nodeConfig().role === "pharmacy")
            return false;
        const hashes = JSON.parse(u.totp_recovery || "[]");
        const i = matchRecovery(code, hashes);
        if (i < 0)
            return false;
        hashes.splice(i, 1);
        db().run("UPDATE users SET totp_recovery = ? WHERE id = ?", [JSON.stringify(hashes), u.id]);
        audit(null, "auth.totp_recovery_used", "user", u.id, { left: hashes.length });
        return true;
    })();
    if (ok) {
        db().run("UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = ?", [u.id]);
        return true;
    }
    const n = (u.totp_failures ?? 0) + 1;
    if (n >= CODE_TRIES) {
        db().run("UPDATE users SET totp_failures = 0, totp_locked_until = ? WHERE id = ?", [toLocalIso(new Date(Date.now() + CODE_LOCK_MINUTES * 60_000)), u.id]);
        audit(null, "auth.totp_locked", "user", u.id, { tries: n });
    }
    else
        db().run("UPDATE users SET totp_failures = ? WHERE id = ?", [n, u.id]);
    return false;
}
/**
 * A PIN, counted per account (whatever the address or PC): after PIN_TRIES wrong in a row the PIN is turned off — the
 * user signs in with their password and sets a new one.
 */
function checkPin(u, pin) {
    if (!u?.pin_hash) {
        checkUserPassword(pin, null);
        return false;
    } // same time either way
    if (checkUserPassword(pin, u.pin_hash)) {
        if (u.pin_failures)
            db().run("UPDATE users SET pin_failures = 0 WHERE id = ?", [u.id]);
        return true;
    }
    const n = (u.pin_failures ?? 0) + 1;
    if (n >= PIN_TRIES) {
        db().run("UPDATE users SET pin_failures = ?, pin_hash = NULL WHERE id = ?", [n, u.id]);
        audit(null, "auth.pin_disabled", "user", u.id, { tries: n });
    }
    else
        db().run("UPDATE users SET pin_failures = ? WHERE id = ?", [n, u.id]);
    return false;
}
function signedInCtx(req, o = {}) {
    const ctx = loadSession(req.cookies[COOKIE]);
    if (!ctx)
        throw new HttpError(401, "Please sign in");
    if (ctx.locked)
        throw new HttpError(423, "The screen is locked", { code: "screen_locked" });
    if (ctx.mustChangePassword)
        throw new HttpError(403, "Change your temporary password first", { code: "must_change_password" });
    if (ctx.mustEnrollTotp && !o.enrolling)
        throw new HttpError(403, "Set up two-step sign-in first", { code: "must_enroll_totp" });
    req.ctx = ctx;
    return ctx;
}
function checkOwnPassword(req, ctx, password) {
    const u = db().get("SELECT password_hash FROM users WHERE id = ?", [ctx.userId]);
    if (!throttledCheck("password", req.ip, ctx.username, () => verifyPassword(password, u?.password_hash)))
        throw new HttpError(400, "Your password is wrong");
}
/** PINs and two-step sign-in belong to the hospital's accounts, kept on the main server (a PC gets them in its copy). */
function mainServerOnly() {
    if (nodeConfig().role === "pharmacy")
        throw new HttpError(409, "Do this on the main server — this pharmacy PC gets the accounts from it", { code: "main_server_only" });
}
/** Opens a session for a user whose identity has been proven, in the pharmacy they work in. */
function startSession(req, reply, u, requestedLoc) {
    const body = { locationId: requestedLoc };
    let loc = u.location_id;
    const isActive = (id) => !!db().get("SELECT 1 FROM locations WHERE id=? AND active=1", [id]);
    // A stale choice (the login screen remembers the last pharmacy) that is now stopped or deleted is ignored.
    const anyPharmacy = accessOf(u).perms.has("pharmacies.all");
    if (body.locationId && (anyPharmacy || !loc) && isActive(body.locationId))
        loc = body.locationId;
    // A stopped pharmacy cannot be worked as (stopping it ends its sessions): admins fall back to an active one,
    // users pinned to it are refused until an admin moves them.
    if (loc && !isActive(loc)) {
        if (!anyPharmacy)
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
    db().run("INSERT INTO sessions(token,user_id,location_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)", [token, u.id, loc, nowIso(), toLocalIso(exp), toLocalIso(new Date())]);
    db().run("UPDATE users SET last_login_at=? WHERE id=?", [nowIso(), u.id]);
    db().run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
    // over HTTPS the cookie is never sent back over plain HTTP (the same port answers both)
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "strict", expires: exp, secure: !!req.raw.socket?.encrypted });
    req.ctx = loadSession(token);
    audit(req, "auth.login");
    return me(req);
}
async function moreAuthRoutes(app) {
    /** Public (pre-login) branding for the sign-in screen: names, message and the hospital-wide look. */
    app.get("/branding", async () => ({
        hospitalName: settingStr("hospital.name"), subtitle: settingStr("hospital.subtitle"), loginMessage: settingStr("auth.login_message"),
        theme: settingStr("ui.theme"), accent: settingStr("ui.accent"), design: featureOn("designs") ? settingStr("ui.design") : "command", font: settingStr("ui.font"), badgeLogin: settingBool("auth.badge_login"),
        language: featureOn("arabic") ? settingStr("ui.language") : "en",
        /** Switched-off features the sign-in and lock screens must know of (Admin → Features). */
        features: { arabic: featureOn("arabic"), screenLock: featureOn("screen_lock"), twoStep: featureOn("two_step") },
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
        const ctx = signedInCtx(req);
        const { locationId } = parse(z.object({ locationId: z.coerce.number().int() }), req.body);
        const home = db().get("SELECT location_id FROM users WHERE id=?", [ctx.userId])?.location_id;
        if (!ctx.perms.has("pharmacies.all") && home && home !== locationId)
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
        if (ctx.role === "admin" || ctx.owner)
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
    const x = db().get("SELECT pin_hash, badge_code, totp_enabled, seen_version, totp_recovery, ui_lang FROM users WHERE id=?", [c.userId]);
    return { id: c.userId, username: c.username, displayName: c.displayName, role: c.role, roleId: c.roleId, roleName: c.roleName, owner: c.owner,
        perms: [...c.perms].sort(), location: loc, homeLocationId: u?.location_id ?? null, mustChangePassword: !!u?.must_change_password,
        locked: !!c.locked, mustEnrollTotp: !!c.mustEnrollTotp, hasPin: !!x?.pin_hash, hasBadge: !!x?.badge_code, totpEnabled: !!x?.totp_enabled,
        recoveryCodesLeft: x?.totp_enabled ? JSON.parse(x.totp_recovery || "[]").length : null, seenVersion: x?.seen_version ?? null,
        uiLang: x?.ui_lang ?? null, language: featureOn("arabic") ? x?.ui_lang ?? settingStr("ui.language") : "en" };
}
