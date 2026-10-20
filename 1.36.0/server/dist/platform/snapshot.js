// A pharmacy PC's copy of the database (GET /api/sync/snapshot, platform/hub.ts). Making one rewrites the whole
// database file several times — seconds on years of history — so the sync route makes it in a worker thread, one copy
// at a time, and the main server keeps answering everyone meanwhile (release 1.35). The plan (whose secrets stay, which
// pharmacy) is worked out on the main thread, from the live database and its roles; the worker only works on files.
import Database from "better-sqlite3-multiple-ciphers";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db, encryptInPlace, openEncrypted } from "../db/index.js";
import { accessOf } from "../auth/access.js";
import { keyPragma } from "./keys.js";
import { dataPath } from "./paths.js";
/** Whose secrets stay in the copy, read on the live database (by their roles). */
export function planSnapshot(live, syncKey, locationId) {
    const users = live.all("SELECT id, role, role_id, location_id FROM users");
    return {
        liveFile: live.file, liveKey: live.key, syncKey, locationId,
        anywhere: users.filter((u) => accessOf(u).perms.has("pharmacies.all")).map((u) => u.id),
        keep: locationId === undefined ? [] : users
            .filter((u) => (u.location_id == null || u.location_id === locationId) && (() => { const a = accessOf(u); return !a.owner && ![...a.perms].some((p) => p.startsWith("admin.") || p === "pharmacies.all"); })())
            .map((u) => u.id),
        trim: live.get("SELECT value AS v FROM settings WHERE key = 'sync.trim_copies'")?.v !== "0",
    };
}
/**
 * Writes the copy into `tmp`: from `source` (an open connection to the live database) or, in the worker, from its own
 * read-only connection. Re-keyed with the PC's sync key. PCs' credentials, sign-ins and the main server's sync
 * bookkeeping are removed first, and so are the password hashes of users pinned to another pharmacy than the PC's
 * (their work there could never be applied, see hub.ts internalCtx, so the PC has no reason to hold what an offline
 * guesser could use). PINs, badges and two-step secrets stay only for the PC's own staff: an administrator (or anyone
 * working across pharmacies) unlocks there with the password, and signs in with two-step on the main server.
 */
export function buildSnapshotFile(plan, tmp, source) {
    rmSync(tmp, { force: true });
    const from = source ?? openEncrypted(plan.liveFile, plan.liveKey);
    try {
        from.prepare("VACUUM INTO ?").run(tmp);
    }
    finally {
        if (!source)
            from.close();
    }
    if (plan.liveKey === null)
        encryptInPlace(tmp, plan.syncKey);
    else {
        const c = new Database(tmp);
        c.pragma(`key = ${keyPragma(plan.liveKey)}`);
        c.pragma(`rekey = ${keyPragma(plan.syncKey)}`);
        c.close();
    }
    const c = new Database(tmp);
    try {
        c.pragma(`key = ${keyPragma(plan.syncKey)}`);
        c.pragma("secure_delete = ON");
        // No sessions at all: the PC keeps its own sign-ins across copies, and a main-server session (an admin's working as
        // this pharmacy, say) would be a live sign-in to the main server for anyone who can read this PC's copy.
        c.exec("DELETE FROM nodes; DELETE FROM applied_ops; DELETE FROM replay_ids; DELETE FROM id_aliases; DELETE FROM sync_issues; DELETE FROM sessions;");
        // the fleet report's key (it signs this hospital's reports to the owner) and, on the owner's server, the hospitals'
        // keys and reports (platform/fleet.ts): main-server business, not for a PC's copy
        c.exec("DELETE FROM schema_meta WHERE key LIKE 'fleet_%'; DELETE FROM fleet_hospitals;");
        // the online assistant's API key (modules/ai/): it is used on the main server only
        c.exec("DELETE FROM schema_meta WHERE key = 'ai_api_key';");
        if (plan.locationId !== undefined) {
            c.prepare(`UPDATE users SET password_hash = '!' WHERE location_id IS NOT NULL AND location_id IS NOT ?
        AND id NOT IN (SELECT value FROM json_each(?))`).run(plan.locationId, JSON.stringify(plan.anywhere));
            // a lost PC must not give anyone an administrator's codes (they sign in on the main server instead), and a
            // 4-digit PIN falls to offline guessing
            c.prepare(`UPDATE users SET totp_secret = NULL, totp_recovery = NULL, pin_hash = NULL, badge_code = NULL
        WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(plan.keep));
            if (plan.trim)
                trimToPharmacy(c, plan.locationId);
        }
        c.exec("VACUUM");
    }
    finally {
        c.close();
    }
}
/**
 * A pharmacy PC's copy keeps only its own pharmacy's patients (release 1.8, setting sync.trim_copies): a lost or stolen
 * PC then holds no other pharmacy's patients. Other pharmacies' patients go with their orders, allergies, alerts and
 * interventions; their dispensing and walk-in tickets stay (stock, transfers and analytics need them) without the
 * patient's ID or name; the audit log keeps this pharmacy's lines (less any about those patients); other pharmacies'
 * dispensing runs and the chat between other pharmacies go. Patients with no department stay.
 */
export function trimToPharmacy(c, locationId) {
    c.pragma("foreign_keys = OFF");
    c.exec("DROP TABLE IF EXISTS temp.gone");
    c.prepare(`CREATE TEMP TABLE gone AS SELECT p.id FROM patients p JOIN departments d ON d.id = p.department_id WHERE d.location_id IS NOT ?`).run(locationId);
    const has = (t) => !!c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    c.exec(`DROP TABLE IF EXISTS temp.gone_orders;
    CREATE TEMP TABLE gone_orders AS SELECT CAST(id AS TEXT) AS id FROM medication_orders WHERE patient_id IN (SELECT id FROM temp.gone);`);
    // audit lines about those patients and their orders, whichever pharmacy wrote them (and the ones with no pharmacy)
    c.exec(`DELETE FROM audit_log WHERE (entity = 'patient' AND entity_id IN (SELECT id FROM temp.gone))
    OR (entity = 'order' AND entity_id IN (SELECT id FROM temp.gone_orders))`);
    for (const t of ["medication_orders", "patient_allergies", "safety_alerts", "interventions"])
        if (has(t))
            c.exec(`DELETE FROM ${t} WHERE patient_id IN (SELECT id FROM temp.gone)`);
    for (const t of ["dispensed_slots", "order_edits_after_dispense"])
        if (has(t))
            c.exec(`DELETE FROM ${t} WHERE order_id NOT IN (SELECT id FROM medication_orders)`);
    c.prepare("UPDATE dispenses SET patient_id = NULL, patient_name = NULL WHERE location_id IS NOT ? AND (patient_id IS NOT NULL OR patient_name IS NOT NULL)").run(locationId);
    c.prepare("UPDATE walkin_tickets SET patient_ref = NULL, patient_name = NULL WHERE location_id IS NOT ?").run(locationId);
    if (has("safety_alerts"))
        c.prepare("DELETE FROM safety_alerts WHERE location_id IS NOT ?").run(locationId);
    c.prepare("DELETE FROM audit_log WHERE location_id IS NOT NULL AND location_id IS NOT ?").run(locationId);
    // other pharmacies' runs hold their printed labels (patient names); their chat, between themselves, is theirs
    c.prepare("DELETE FROM dispense_runs WHERE location_id IS NOT ?").run(locationId);
    c.prepare(`DELETE FROM chat_messages WHERE to_location_id IS NOT NULL AND to_location_id IS NOT ?
    AND from_location_id IS NOT ?`).run(locationId, locationId);
    c.exec("DELETE FROM patients WHERE id IN (SELECT id FROM temp.gone); DROP TABLE temp.gone; DROP TABLE temp.gone_orders;");
    // what the hospital system sent about patients who are not kept here (or not admitted anywhere yet)
    if (has("his_messages"))
        c.exec("DELETE FROM his_messages WHERE patient_id IS NULL OR patient_id NOT IN (SELECT id FROM patients)");
}
/**
 * The worker: snapshot-worker.js once built; in development and tests (TypeScript run through tsx) a small bootstrap
 * that registers tsx's loader in the worker first, since a worker does not inherit it.
 */
function startWorker(workerData) {
    if (!fileURLToPath(import.meta.url).endsWith(".ts"))
        return new Worker(new URL("./snapshot-worker.js", import.meta.url), { workerData });
    const entry = new URL("./snapshot-worker.ts", import.meta.url).href;
    return new Worker(`import("tsx/esm/api").then((t) => { t.register(); return import(${JSON.stringify(entry)}); })`, { eval: true, workerData });
}
/** One copy at a time: several PCs asking at once queue up, rather than each taking the main server's disk and CPU. */
let queue = Promise.resolve();
/** Makes a PC's copy in a worker thread; resolves with the file. Falls back to this thread if no worker can start. */
export function makeNodeSnapshotAsync(syncKey, locationId) {
    const run = async () => {
        const live = db();
        const plan = planSnapshot(live, syncKey, locationId);
        const tmp = dataPath(`snapshot-${randomUUID()}.tmp`);
        if (live.file === ":memory:") {
            buildSnapshotFile(plan, tmp, live.raw);
            return tmp;
        }
        try {
            await inWorker(plan, tmp);
        }
        catch (e) {
            // (no worker here, or it failed: made on this thread, as before 1.35 — a real failure then shows as before)
            console.warn("[sync] the copy for a pharmacy PC was made without a worker:", e?.message ?? e);
            rmSync(tmp, { force: true });
            buildSnapshotFile(plan, tmp, live.raw);
        }
        return tmp;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
}
function inWorker(plan, tmp) {
    return new Promise((resolve, reject) => {
        let w;
        try {
            w = startWorker({ plan, tmp });
        }
        catch (e) {
            reject(e);
            return;
        }
        w.once("message", (m) => (m.ok ? resolve() : reject(new Error(m.error ?? "The copy could not be made"))));
        w.once("error", reject);
        w.once("exit", (code) => reject(new Error(`The copy's worker stopped (${code})`))); // (no effect once settled)
    });
}
