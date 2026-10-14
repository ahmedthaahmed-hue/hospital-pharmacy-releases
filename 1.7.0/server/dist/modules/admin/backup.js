// Server-side online backups (replaces legacy ModBackUP.HourlyBackupAndReplace).
// Deliberate changes vs legacy (FEATURES.md §2.17, bug §5.32):
//  - one process (the server) backs up, not every open workstation;
//  - `VACUUM INTO` writes a consistent snapshot of the live DB (legacy file-copied a live multi-user .accdb);
//  - folder comes from settings (backup.dir, relative to the server cwd), not hardcoded C:\ / D:\;
//  - results go to audit_log ('backup.auto' / 'admin.backup.create') instead of a text file on a workstation;
//  - no "C:\Upgrade\DataBE.accdb" staging copy (undocumented purpose, not needed with a server DB).
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../../db/index.js";
import { audit } from "../../lib/http.js";
import { toLocalIso } from "../../lib/time.js";
export const BACKUP_RE = /^pharmacy_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:-\d+)?\.sqlite$/;
const HOUR = 3_600_000;
function setting(key, fallback) {
    return db().get("SELECT value FROM settings WHERE key=?", [key])?.value || fallback;
}
export function backupDir() {
    return resolve(process.cwd(), setting("backup.dir", "backups"));
}
export function keepDays() {
    const n = Number(setting("backup.keep_days", "30"));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}
/** Time encoded in a backup file name (local wall clock). */
function nameTime(name) {
    const m = BACKUP_RE.exec(name);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
/** Backups in the configured folder, newest first. Missing folder → []. */
export function listBackups(dir = backupDir()) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const name of readdirSync(dir)) {
        const t = nameTime(name);
        if (!t)
            continue;
        try {
            const st = statSync(join(dir, name));
            if (st.isFile())
                out.push({ name, size: st.size, at: toLocalIso(t) });
        }
        catch { /* vanished between readdir and stat */ }
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
/** Delete backups whose (name) time is older than keep_days. Only touches files matching our naming pattern. */
export function pruneBackups(dir = backupDir(), days = keepDays(), now = new Date()) {
    const cutoff = now.getTime() - days * 24 * HOUR;
    const removed = [];
    for (const b of listBackups(dir)) {
        const t = nameTime(b.name);
        if (t.getTime() < cutoff) {
            try {
                unlinkSync(join(dir, b.name));
                removed.push(b.name);
            }
            catch { /* locked/permission: try again next hour */ }
        }
    }
    return removed;
}
/** Write a consistent online snapshot with VACUUM INTO, then prune. Throws on failure. */
export function runBackup(now = new Date()) {
    const d = db();
    if (d.file === ":memory:")
        throw new Error("The database is in memory — there is no file to back up");
    const started = Date.now();
    const dir = backupDir();
    mkdirSync(dir, { recursive: true });
    const stamp = toLocalIso(now).replace("T", "_").replace(/:/g, "");
    let name = `pharmacy_${stamp}.sqlite`;
    for (let i = 2; existsSync(join(dir, name)); i++)
        name = `pharmacy_${stamp}-${i}.sqlite`;
    const file = join(dir, name);
    // VACUUM INTO takes an expression, so the path is bound — never concatenated into SQL.
    d.raw.prepare("VACUUM INTO ?").run(file);
    const size = statSync(file).size;
    const pruned = pruneBackups(dir, keepDays(), now);
    return { ok: true, file, name, size, ms: Date.now() - started, pruned };
}
/** Newest backup time, or null. */
export function lastBackupAt() {
    const b = listBackups()[0];
    return b ? nameTime(b.name) : null;
}
/** Scheduled run: never throws, always leaves a line in the audit log. */
export function autoBackup() {
    try {
        const r = runBackup();
        audit(null, "backup.auto", "backup", r.name, { ok: true, size: r.size, ms: r.ms, pruned: r.pruned });
    }
    catch (e) {
        const msg = String(e?.message ?? e);
        console.error(`[backup] failed: ${msg}`);
        try {
            audit(null, "backup.auto", "backup", null, { ok: false, error: msg });
        }
        catch { /* DB itself unavailable */ }
    }
}
let timers = [];
/** Hours between automatic backups (setting 'backup.interval_hours', default 1). */
export function intervalMs() {
    const n = Number(setting("backup.interval_hours", "1"));
    return (Number.isFinite(n) && n >= 1 && n <= 24 ? Math.floor(n) : 1) * HOUR;
}
/**
 * Backups every 'backup.interval_hours' for the life of the process. Also runs shortly after startup when the newest
 * backup is older than that interval (or there is none). Timers are unref'd so they never keep the process alive.
 * Idempotent.
 */
export function startBackupSchedule(opts = {}) {
    stopBackupSchedule();
    try {
        if (db().file === ":memory:")
            return;
        const last = lastBackupAt();
        const every = intervalMs();
        if (!last || Date.now() - last.getTime() > every) {
            const t = setTimeout(autoBackup, opts.startupDelayMs ?? 10_000);
            t.unref();
            timers.push(t);
        }
        const iv = setInterval(autoBackup, every);
        iv.unref();
        timers.push(iv);
    }
    catch (e) {
        console.error(`[backup] schedule not started: ${String(e?.message ?? e)}`);
    }
}
/** Re-arm with the current interval — only when a schedule is already running (the server, not tests/CLI). */
export function restartBackupSchedule() {
    if (timers.length)
        startBackupSchedule({ startupDelayMs: 60_000 });
}
export function stopBackupSchedule() {
    for (const t of timers)
        clearTimeout(t);
    timers = [];
}
