// The owner's remote access (release 1.58, docs/OWNER.md): the system's owner administers any installation from far
// away — the catalogue, kits and templates, stock, settings, features, accounts, updates — without ever seeing a
// patient. It rides on the phones' sealed connection (platform/phone.ts, the owner's relay), so the hospital opens no
// port and the relay reads nothing.
//
//   Who     A request sealed with one of the owner's keys. Only the owner's signed control file names them
//           (control.json ownerKeys, releases.ts), so nobody at a hospital, and no relay, can add one.
//   As      The hospital's own owner account (the first active one), in a session marked as remote (sessions.device_id
//           OWNER_REMOTE). It needs no PC to be signed in, and is not stopped by the phone app's feature switch.
//   What    Only the routes in ALLOWED: each was read and found to carry no patient's data. Everything else — patients,
//           orders, dispensing, the daily run, walk-ins, reports, records, messages, the audit log, backups — answers
//           403 before any route runs. The session's permissions leave the same out (REMOTE_NEVER), and an answer that
//           still carries a patient's field is not sent (carriesPatientData): three fences, each enough on its own.
//   Seen    Everything done is in the hospital's audit log, marked ownerRemote; Admin → Updates shows when the owner
//           last connected.
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { isDemo } from "../db/demo.js";
import { accessOf } from "../auth/access.js";
import { settingStr } from "../core/settings.js";
import { nowIso, toLocalIso } from "../lib/time.js";
import { displayCode, licenceStatus, machineCodeOrNull } from "./licence.js";
import { lastBackupAt } from "../modules/admin/backup.js";
import { lockState } from "./updater.js";
import { nodeConfig } from "./node-config.js";
import { appVersion } from "./version.js";
/** sessions.device_id of the owner's remote session (a linked phone's is its phone_devices id, a PC's is NULL). */
export const OWNER_REMOTE = -1;
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]);
/** A P-256 public key as the phone app writes it (65 bytes, base64url). */
const KEY_RE = /^[A-Za-z0-9_-]{86,88}$/;
/** The owner's keys, as the last signed control file named them. */
export function ownerKeys() {
    try {
        const v = JSON.parse(META("owner_keys") ?? "[]");
        return Array.isArray(v) ? v.filter((k) => typeof k === "string" && KEY_RE.test(k)) : [];
    }
    catch {
        return [];
    }
}
/** From the signed control file only (updater.ts checkControl). A key no longer named stops working at once. */
export function setOwnerKeys(keys) {
    const list = Array.isArray(keys) ? [...new Set(keys.filter((k) => typeof k === "string" && KEY_RE.test(k)))].slice(0, 20) : [];
    const next = JSON.stringify(list);
    if (next === (META("owner_keys") ?? "[]"))
        return;
    db().untracked(() => { SET("owner_keys", next); db().run("DELETE FROM sessions WHERE device_id = ?", [OWNER_REMOTE]); });
    token = null;
}
/** The owner can reach this installation: a main server, and the owner has named at least one key. */
export const ownerRemoteOn = () => nodeConfig().role === "server" && ownerKeys().length > 0;
/* ---------------- what the remote session may do ---------------- */
/** Permissions the remote session never has: the work with patients, what shows them, and what copies the data. */
export const REMOTE_NEVER = new Set(["dispense", "runs", "orders", "orders.verify", "walkin", "patients", "reports", "records", "admin.backups", "phone"]);
export function remoteAccess(a) {
    return { ...a, perms: new Set([...a.perms].filter((p) => !REMOTE_NEVER.has(p))) };
}
const ID = "\\d+", ANY = "[^/]+";
const r = (methods, path) => [methods, new RegExp(`^/api/${path}/?$`)];
/**
 * Every route the remote session may call. Each was read, handler and helpers, for patients' data (release 1.58; the
 * review's outcome is in docs/OWNER.md). A route not here is refused: a new route stays closed until someone reads it
 * and adds it. Numeric ids are matched as numbers, so a route that acts on a patient (apply, from-patient,
 * from-ticket, apply-kit) can never pass as an id. Left out on purpose, though they hold no patient: what copies the
 * database (backups), bulk TEMP stock, moving a department's patients, renaming a patient status, badges, signing in
 * or out, and the account's own password, PIN and two-step sign-in.
 */
export const ALLOWED = [
    r("GET", "auth/(branding|logo|locations|me)"), r("POST", "auth/(activity|location)"),
    r("GET", "lookups(/items)?"),
    // the catalogue (not the opening label, which can carry a patient)
    r("GET,POST", "items"), r("GET", "items/(facets|next-number|to-complete|standard-list)"), r("POST", "items/(fill-from-similar|standard-list)"),
    r("GET,PATCH,PUT,DELETE", `items/${ANY}`), r("GET", `items/${ANY}/card`), r("POST", `items/${ANY}/(activate|deactivate)`),
    // stock (not the movement ledgers or a recall's trace, which name patients; not the bulk TEMP stock)
    r("GET", "stock/(overview|count-sheet|expiring|expired|placeholders|holds|reconcile)"), r("GET", `stock/items/${ANY}/batches`), r("GET", `stock/batches/${ID}`),
    r("POST", "stock/(receive|count|holds)"), r("POST", `stock/batches/${ID}/adjust`), r("POST", `stock/holds/${ID}/release`),
    // templates (not from a patient's orders or a walk-in ticket, nor applying one to a patient)
    r("GET,POST", "rx-templates"), r("GET,PATCH,DELETE", `rx-templates/${ID}`), r("POST", `rx-templates/${ID}/(duplicate|lines)`), r("PATCH,DELETE", `rx-templates/${ID}/lines/${ID}`),
    r("GET,POST", "order-templates"), r("GET,PATCH,DELETE", `order-templates/${ID}`), r("POST", `order-templates/${ID}/(duplicate|lines)`),
    r("POST", `order-templates/${ID}/lines/${ID}/move`), r("PATCH,DELETE", `order-templates/${ID}/lines/${ID}`),
    // operations and their kits (not applying a kit to a patient)
    r("GET,POST", "operations"), r("GET,POST", "operations/(standard-kits|exclusions)"), r("PATCH,DELETE", `operations/exclusions/${ID}`),
    r("GET,PATCH,DELETE", `operations/${ID}`), r("GET,POST", `operations/${ID}/kit`), r("PATCH", `operations/kits/${ID}`),
    r("POST", `operations/kits/${ID}/lines`), r("PATCH,DELETE", `operations/kits/${ID}/lines/${ID}`),
    // administration (not the audit log, backups, badges, a department's move, or resetting every setting)
    r("GET,POST,DELETE", "admin/label-font"), r("POST", "admin/demo/reset"),
    r("GET,POST", "admin/users"), r("PATCH", `admin/users/${ID}`), r("POST", `admin/users/${ID}/(reset-password|reset-two-step)`),
    r("GET", "admin/sessions"), r("DELETE", `admin/sessions/${ANY}`),
    r("GET,POST", "admin/locations"), r("PATCH,DELETE", `admin/locations/${ID}`),
    r("GET,POST", "admin/departments"), r("PATCH,DELETE", `admin/departments/${ID}`),
    r("GET,POST", `admin/lookups/${ANY}`), r("DELETE", `admin/lookups/${ANY}/${ANY}`), r("PATCH", `admin/lookups/(?!statuses/)${ANY}/${ANY}`),
    r("GET", "admin/(settings|settings/schema|features|audit/facets|health|system|roles|roles/catalog|layouts)"),
    r("PUT", "admin/settings"), r("POST", "admin/health/check-database"),
    r("POST", "admin/roles"), r("PATCH,DELETE", `admin/roles/${ID}`), r("PUT,DELETE", `admin/layouts/${ANY}/${ANY}`),
    r("GET", "layouts"),
    // safety rules and items' safety details (not a check for a patient, nor the alert log)
    r("GET,POST", "safety/rules"), r("PUT,DELETE", `safety/rules/${ID}`), r("GET", "safety/(vocabulary|items)"), r("GET,PATCH", `safety/items/${ANY}`),
    // barcodes of items (not the lookup, which also finds patients)
    r("GET", `barcodes/item/${ANY}`), r("POST", "barcodes"), r("DELETE", `barcodes/${ANY}`),
    // supply
    r("GET,POST", "transfers"), r("GET", `transfers/(${ID}|levels|suggestions|redistribution)`), r("POST", "transfers/send"),
    r("POST", `transfers/${ID}/(issue|receive|cancel|reject|refuse)`), r("PUT", `transfers/levels/${ANY}`),
    r("GET,POST", "purchasing/(suppliers|orders|returns)"), r("PUT", `purchasing/suppliers/${ID}`), r("GET,PUT", `purchasing/orders/${ID}`),
    r("POST", `purchasing/orders/${ID}/(send|cancel|close)`), r("GET", "purchasing/value"),
    // totals only
    r("GET", "analytics/(overview|stock-health|reorder|alerts)"), r("GET", `analytics/item/${ANY}`),
    // updates
    r("GET", "update/status"), r("POST", "update/(check|apply)"),
];
/** Settings the remote session never writes: they send the hospital's data to a folder (backups, the HIS exchange). */
const SETTINGS_NEVER = /^(backup|his)\./;
export function ownerMayCall(method, url) {
    const path = url.split("?")[0];
    if (path.includes("..") || /%2e|%2f|%5c|\\/i.test(path) || !path.startsWith("/api/"))
        return false;
    const m = method.toUpperCase();
    return ALLOWED.some(([methods, re]) => (methods === "*" || methods.split(",").includes(m)) && re.test(path));
}
/** Names of fields that hold a patient's data: an answer with one of them filled in is not sent. */
const PATIENT_KEY = /^(patient|patients|patient_?(id|name|no|code|ref)|mrn|dispenseId|ticketId)$/i;
const EXEMPT_KEY = new Set(["patientStatuses"]);
/** True when the answer holds a patient's field (a number alone, a count, is not one). Looked at to a sane depth. */
export function carriesPatientData(v, depth = 0) {
    if (v == null || typeof v !== "object" || depth > 12)
        return false;
    if (Array.isArray(v))
        return v.some((x) => carriesPatientData(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
        if (EXEMPT_KEY.has(k))
            continue;
        if (PATIENT_KEY.test(k)) {
            const filled = typeof x === "string" ? x.trim() !== "" : typeof x === "object" ? x != null && (Array.isArray(x) ? x.length > 0 : Object.keys(x).length > 0)
                : typeof x === "number" ? /id$/i.test(k) : false;
            if (filled)
                return true;
        }
        if (carriesPatientData(x, depth + 1))
            return true;
    }
    return false;
}
/* ---------------- the session ---------------- */
let token = null;
/** (tests) */
export function resetOwnerRemote() { token = null; }
/** The remote session's token: the hospital's own owner account, at its pharmacy. Null when it has no owner account. */
export function ownerSession() {
    const u = db().all("SELECT id, role, role_id, location_id FROM users WHERE active = 1 ORDER BY id").find((x) => accessOf(x).owner);
    if (!u)
        return null;
    const expires = toLocalIso(new Date(Date.now() + 12 * 3600_000));
    const s = token ? db().get("SELECT token FROM sessions WHERE token = ? AND device_id = ? AND user_id = ? AND expires_at > ?", [token, OWNER_REMOTE, u.id, nowIso()]) : undefined;
    db().untracked(() => {
        if (s) {
            db().run("UPDATE sessions SET expires_at = ?, last_seen_at = ?, locked_at = NULL WHERE token = ?", [expires, nowIso(), token]);
            return;
        }
        const loc = (u.location_id != null && db().get("SELECT id FROM locations WHERE id = ? AND active = 1", [u.location_id])?.id)
            || db().get("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1")?.id;
        if (!loc) {
            token = null;
            return;
        }
        token = randomBytes(32).toString("hex");
        db().run("DELETE FROM sessions WHERE device_id = ?", [OWNER_REMOTE]);
        db().run("INSERT INTO sessions(token,user_id,location_id,created_at,expires_at,last_seen_at,device_id) VALUES (?,?,?,?,?,?,?)", [token, u.id, loc, nowIso(), expires, nowIso(), OWNER_REMOTE]);
    });
    return token;
}
/** When the owner last connected (shown to the hospital's admins), or null. */
export const ownerLastSeen = () => META("owner_remote_seen") || null;
let seenNoted = 0;
function noteSeen() {
    // once a session of work (an hour), in the audit log too: the hospital sees that the owner connected
    if (Date.now() - seenNoted < 3600_000) {
        db().untracked(() => SET("owner_remote_seen", nowIso()));
        return;
    }
    seenNoted = Date.now();
    db().untracked(() => SET("owner_remote_seen", nowIso()));
    db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "owner.remote.connect", "system", JSON.stringify({ ownerRemote: true })]);
}
/**
 * (1.59) The control room's line for this installation (the owner app, docs/OWNER.md): how it is doing — its licence,
 * its pharmacy PCs, its last backup, whether it is locked. Counts and times only: nothing about any patient or person.
 */
export function ownerHealth() {
    const l = licenceStatus(), lock = lockState();
    const since = toLocalIso(new Date(Date.now() - 15 * 60_000));
    const pcs = db().get("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END), 0) online FROM nodes WHERE status = 'active'", [since]);
    const backup = lastBackupAt();
    return {
        licence: { state: l.state, expires: l.expires, pharmacyPcs: l.pharmacyPcs },
        pcs: { total: pcs?.total ?? 0, online: pcs?.online ?? 0 },
        lastBackup: backup ? toLocalIso(backup) : null,
        locked: lock.locked, lockReason: lock.reason,
    };
}
const refuse = (status, error, code) => ({ status, body: { error, code } });
/**
 * One request sealed with `key` (the envelope opened with it, so whoever sent it holds that key). `forward` runs an
 * allowed call in the remote session and gives its answer (phone.ts).
 */
export async function ownerAct(key, req, forward) {
    if (nodeConfig().role !== "server" || !ownerKeys().includes(key))
        return refuse(403, "Refused", "refused");
    noteSeen();
    if (req.m == null) {
        // hello: which installation this is, as it says itself
        const code = machineCodeOrNull();
        return { status: 200, body: { hospital: settingStr("hospital.name") || null, machine: code ? displayCode(code) : null, version: appVersion(), demo: isDemo(db), health: ownerHealth() } };
    }
    const method = String(req.m).toUpperCase(), url = String(req.u ?? "");
    if (!ownerMayCall(method, url))
        return refuse(403, "Not part of the owner's remote access: it is kept to what holds no patient's data", "not_remote");
    if (method === "PUT" && /^\/api\/admin\/settings\/?$/.test(url.split("?")[0]) && req.b && typeof req.b === "object" && Object.keys(req.b).some((k) => SETTINGS_NEVER.test(k)))
        return refuse(403, "The owner's remote access does not change where backups or the hospital system's files go", "not_remote");
    const t = ownerSession();
    if (!t)
        return refuse(409, "This installation has no active owner account (or no pharmacy) to work as", "no_owner_account");
    const a = await forward(t, method, url, req.b);
    if (a.status < 400 && carriesPatientData(a.body))
        return refuse(403, "This answer holds a patient's data: it is not sent to the owner's remote access", "patient_data");
    return a;
}
