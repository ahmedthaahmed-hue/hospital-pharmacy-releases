// Checked backups (release 1.8). A backup nobody has opened is a hope, not a backup: every backup is opened again with
// the database key, checked page by page (PRAGMA quick_check) and its main tables counted; a copy goes to a second place
// (a USB disk or a shared folder on another PC, setting backup.copy_dir) and that copy is checked to be the same file.
// "Test a restore" opens a chosen backup the same way, as a restore would, without changing the live database.
// Results are kept in backup_checks and shown in Admin → Backups and on the System health page.
import Database from "better-sqlite3-multiple-ciphers";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { db } from "../../db/index.js";
import { keyPragma } from "../../platform/keys.js";
import { nowIso } from "../../lib/time.js";
import { BACKUP_RE, backupDir, keepDays } from "./backup.js";
import { copyDirProblem } from "../../lib/folders.js";
/** The tables counted in a check (what a restore must bring back). */
export const CHECKED_TABLES = ["patients", "medication_orders", "dispenses", "batches", "stock_movements", "items", "users"];
/** Opens a backup read-only with the key, checks it and counts its main tables. Never changes the file. */
export function checkBackupFile(file, key) {
    const started = Date.now();
    let raw = null;
    try {
        raw = new Database(file, { readonly: true, fileMustExist: true });
        if (key)
            raw.pragma(`key = ${keyPragma(key)}`);
        const integrity = String(raw.pragma("quick_check", { simple: true }) ?? "");
        const have = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        const counts = {};
        for (const t of CHECKED_TABLES)
            if (have.has(t))
                counts[t] = raw.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
        const ok = integrity === "ok" && have.has("users") && (counts.users ?? 0) > 0;
        return { ok, integrity, counts, error: ok ? null : integrity !== "ok" ? `Damaged: ${integrity.slice(0, 200)}` : "It has no users: not a usable database", ms: Date.now() - started };
    }
    catch (e) {
        const msg = String(e?.message ?? e);
        return { ok: false, integrity: "", counts: {}, error: /not a database|file is encrypted/i.test(msg) ? "Cannot be opened with this database's key" : msg, ms: Date.now() - started };
    }
    finally {
        raw?.close();
    }
}
/** The file's SHA-256, read as a stream (a backup can be large; a network share slow). */
const sha256 = (file) => new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});
/** The second place backups are copied to (absolute path), or null when not set (or set to a folder it cannot use). */
export function copyDir() {
    const v = db().get("SELECT value FROM settings WHERE key = 'backup.copy_dir'")?.value?.trim();
    if (!v || copyDirProblem(v) || !isAbsolute(v))
        return null;
    return v;
}
/** Copies a backup to the second place and checks the copy is the same file; prunes old copies there. */
export async function copyBackup(file, dir) {
    const target = join(dir, basename(file));
    if (resolve(dir) === resolve(backupDir()))
        return { ok: false, target, error: "The second place is the backup folder itself: choose another disk or PC" };
    try {
        await mkdir(dir, { recursive: true });
        await copyFile(file, target);
        if ((await stat(target)).size !== (await stat(file)).size || (await sha256(target)) !== (await sha256(file)))
            return { ok: false, target, error: "The copy differs from the backup" };
        // keep the same number of days there as here
        const cutoff = Date.now() - keepDays() * 24 * 3600_000;
        for (const n of await readdir(dir)) {
            if (!BACKUP_RE.test(n))
                continue;
            try {
                if ((await stat(join(dir, n))).mtimeMs < cutoff)
                    await unlink(join(dir, n));
            }
            catch { /* in use: next time */ }
        }
        return { ok: true, target, error: null };
    }
    catch (e) {
        return { ok: false, target, error: `Could not copy to ${dir}: ${String(e?.code === "ENOENT" ? "the folder or drive is not there (USB disk unplugged?)" : e?.message ?? e)}` };
    }
}
/** Checks a backup just made (and copies it to the second place); records the result. */
export async function checkAndCopy(file, kind) {
    const r = checkBackupFile(file, db().key);
    const dir = kind === "restore_test" ? null : copyDir();
    const copy = dir && r.ok ? await copyBackup(file, dir) : null;
    const error = r.error ?? copy?.error ?? null;
    const id = db().run(`INSERT INTO backup_checks(at, kind, file, ok, integrity, counts, copied_to, copy_ok, error, ms) VALUES (?,?,?,?,?,?,?,?,?,?)`, [nowIso(), kind, basename(file), r.ok && (copy?.ok ?? true) ? 1 : 0, r.integrity || null, JSON.stringify(r.counts), copy?.target ?? null,
        copy ? (copy.ok ? 1 : 0) : null, error, r.ms]).lastId;
    db().run("DELETE FROM backup_checks WHERE id NOT IN (SELECT id FROM backup_checks ORDER BY id DESC LIMIT 500)");
    return backupCheck(id);
}
export function backupCheck(id) {
    const r = db().get("SELECT * FROM backup_checks WHERE id = ?", [id]);
    return r ? rowOf(r) : null;
}
export function recentChecks(limit = 20) {
    return db().all("SELECT * FROM backup_checks ORDER BY id DESC LIMIT ?", [limit]).map(rowOf);
}
const rowOf = (r) => ({ id: r.id, at: r.at, kind: r.kind, file: r.file, ok: !!r.ok, integrity: r.integrity, counts: JSON.parse(r.counts || "{}"),
    copiedTo: r.copied_to, copyOk: r.copy_ok == null ? null : !!r.copy_ok, error: r.error, ms: r.ms });
/**
 * Whether a folder is there (for the settings screen and System health: is the USB disk plugged in?). A shared folder
 * on a PC that is off can take a minute to fail, so this gives up after a few seconds: not reachable.
 */
export function dirExists(p, timeoutMs = 3000) {
    return Promise.race([
        stat(p).then((s) => s.isDirectory(), () => false),
        new Promise((r) => setTimeout(() => r(false), timeoutMs).unref()),
    ]);
}
