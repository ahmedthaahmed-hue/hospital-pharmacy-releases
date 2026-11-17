// The database: one SQLite file per PC, encrypted at rest (SQLite3 Multiple Ciphers, see platform/keys.ts).
// Db wraps the driver with small helpers (all/get/run/tx) that every module uses; nothing else talks to the driver.
import Database from "better-sqlite3-multiple-ciphers";
import { readFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, statSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { seedBase } from "./seed-base.js";
import { dataMigrations } from "./migrations.js";
import { runVersionedMigrations } from "./versioned.js";
import { loadOrCreateKey, keyPragma } from "../platform/keys.js";
import { currentUserId } from "../platform/clock.js";
const here = dirname(fileURLToPath(import.meta.url));
/** Number of positional slots (`?`, `?NNN`) in a statement, ignoring string literals, quoted names and comments. */
export function placeholderCount(sql) { return placeholders(sql).slots; }
/** Slots of a statement and whether it uses numbered (?NNN) parameters, which the driver binds by number. */
export function placeholders(sql) {
    let n = 0, max = 0;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'" || c === '"' || c === "`") {
            const end = sql.indexOf(c, i + 1);
            i = end < 0 ? sql.length : end;
        }
        else if (c === "[") {
            const end = sql.indexOf("]", i + 1);
            i = end < 0 ? sql.length : end;
        }
        else if (c === "-" && sql[i + 1] === "-") {
            const end = sql.indexOf("\n", i);
            i = end < 0 ? sql.length : end;
        }
        else if (c === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            i = end < 0 ? sql.length : end + 1;
        }
        else if (c === "?") {
            const m = /^\d+/.exec(sql.slice(i + 1));
            if (m) {
                max = Math.max(max, Number(m[0]));
                i += m[0].length;
            }
            else
                n++;
        }
    }
    return { slots: Math.max(n, max), numbered: max > 0 };
}
/** True when the file is an ordinary (unencrypted) SQLite database. */
export function isPlainSqlite(file) {
    if (!existsSync(file) || statSync(file).size < 16)
        return false;
    const fd = openSync(file, "r");
    try {
        const b = Buffer.alloc(16);
        readSync(fd, b, 0, 16, 0);
        return b.toString("latin1") === "SQLite format 3\0";
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Opens a database file with its key. A plain SQLite file (databases from before encryption, uploaded copies) is
 * encrypted in place first. A wrong key fails here with a clear message instead of on the first query.
 */
export function openEncrypted(file, key) {
    return withFunctions(openWithKey(file, key));
}
/** SQL functions the schema's triggers use: hps_user() is the user the current request works as (or NULL). */
function withFunctions(raw) {
    raw.function("hps_user", { deterministic: false, varargs: false }, () => currentUserId());
    return raw;
}
function openWithKey(file, key) {
    if (file === ":memory:" || key === null)
        return new Database(file);
    if (isPlainSqlite(file))
        encryptInPlace(file, key);
    const raw = new Database(file);
    raw.pragma(`key = ${keyPragma(key)}`);
    try {
        raw.prepare("SELECT count(*) FROM sqlite_master").get();
    }
    catch (e) {
        raw.close();
        throw new Error(`Cannot open ${file}: it is encrypted with a different key (${e.message}). Use the recovery key of that database.`);
    }
    return raw;
}
/** Encrypts a plain SQLite file in place (checkpointing its WAL first). */
export function encryptInPlace(file, key) {
    const plain = new Database(file);
    try {
        plain.pragma("wal_checkpoint(TRUNCATE)");
        plain.pragma("journal_mode = DELETE");
        plain.pragma(`rekey = ${keyPragma(key)}`);
    }
    finally {
        plain.close();
    }
}
let observer = null;
export function setWriteObserver(o) { observer = o; }
/** The table an INSERT / REPLACE statement writes to (null for other statements). */
export function insertTarget(sql) {
    const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+["`[]?(\w+)/i.exec(sql);
    return m ? m[1] : null;
}
export class Db {
    file;
    key;
    raw;
    depth = 0;
    /** last_insert_rowid() after the previous write: an upsert that updated leaves it unchanged (it inserted nothing). */
    lastRowid = 0;
    /** Bumped on every committed change made through this wrapper; replicas use it to know when to refresh. */
    revision = 0;
    bootId = randomUUID();
    constructor(file, key = null) {
        this.file = file;
        this.key = key;
        if (file !== ":memory:")
            mkdirSync(dirname(resolve(file)), { recursive: true });
        this.raw = openEncrypted(file, key);
        this.raw.pragma("journal_mode = WAL");
        this.raw.pragma("foreign_keys = ON");
        this.raw.pragma("busy_timeout = 5000");
    }
    migrate() {
        // schema.sql lives next to this file in src/ and is copied to dist/ at build time.
        const sql = readFileSync(resolve(here, "schema.sql"), "utf8");
        this.raw.exec(sql);
        runVersionedMigrations(this);
        seedBase(this);
        dataMigrations(this);
    }
    stmts = new Map();
    /** Prepared statements are cached per SQL text; positional params beyond the statement's slots are ignored. */
    prep(sql, params) {
        let s = this.stmts.get(sql);
        if (!s) {
            s = { stmt: this.raw.prepare(sql), ...placeholders(sql) };
            if (this.stmts.size > 2000)
                this.stmts.clear();
            this.stmts.set(sql, s);
        }
        if (params === undefined)
            return [s.stmt, []];
        if (!Array.isArray(params))
            return [s.stmt, [params]];
        const a = params.length > s.slots ? params.slice(0, s.slots) : params;
        return [s.stmt, s.numbered ? [Object.fromEntries(a.map((v, i) => [i + 1, v]))] : a];
    }
    all(sql, params) {
        const [st, a] = this.prep(sql, params);
        return st.all(...a);
    }
    get(sql, params) {
        const [st, a] = this.prep(sql, params);
        return st.get(...a);
    }
    run(sql, params) {
        // A write outside any transaction commits on its own: give it one, so the observer's beforeCommit runs with it.
        if (this.depth === 0 && observer?.wantsTx())
            return this.tx(() => this.run(sql, params));
        const [st, a] = this.prep(sql, params);
        const r = st.run(...a);
        const lastId = Number(r.lastInsertRowid), changes = Number(r.changes);
        if (changes > 0) {
            if (this.depth === 0)
                this.revision++;
            const table = observer ? insertTarget(sql) : null;
            if (table && !(lastId === this.lastRowid && /\bON\s+CONFLICT\b/i.test(sql)))
                observer.inserted(table, lastId - changes + 1, changes);
        }
        this.lastRowid = lastId;
        return { changes, lastId };
    }
    /** Nested-safe transaction (savepoints). Throwing rolls back. */
    tx(fn) {
        const outer = this.depth === 0;
        const name = `sp${this.depth}`;
        this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
        this.depth++;
        const mark = observer?.began?.();
        let done = false;
        try {
            const r = fn();
            if (outer)
                observer?.beforeCommit(this);
            this.raw.exec(outer ? "COMMIT" : `RELEASE ${name}`);
            done = true;
            if (outer) {
                this.revision++;
                observer?.afterCommit();
            }
            return r;
        }
        finally {
            // Decrement exactly once, also when COMMIT itself fails (e.g. busy / disk full): roll back what is still open.
            this.depth--;
            if (!done) {
                if (outer) {
                    try {
                        this.raw.exec("ROLLBACK");
                    }
                    catch { /* SQLite already rolled it back; keep the original error */ }
                }
                else
                    this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
                if (mark !== undefined)
                    observer?.rolledBack?.(mark);
            }
        }
    }
    /**
     * Runs fn without counting its writes as a change. For bookkeeping that pharmacy PCs' copies do not need (a PC's
     * last-seen time, its sync state): otherwise every heartbeat would look like new data and make every pharmacy PC
     * download a full copy of the database again.
     */
    untracked(fn) {
        const r = this.revision;
        try {
            return fn();
        }
        finally {
            this.revision = r;
        }
    }
    /** A consistent, encrypted copy of the whole database (same key) at `target`. */
    snapshotTo(target) {
        rmSync(target, { force: true });
        this.raw.prepare("VACUUM INTO ?").run(target);
    }
    close() { this.raw.close(); }
}
/** Key file of the database at `file` (db.key next to it). */
export const keyFileFor = (file) => join(dirname(resolve(file)), "db.key");
let instance = null;
export function openDb(file = process.env.DB_FILE ?? "data/pharmacy.sqlite") {
    const key = file === ":memory:" || process.env.DB_PLAIN === "1" ? null : loadOrCreateKey(keyFileFor(file));
    const db = new Db(file, key);
    db.migrate();
    instance = db;
    return db;
}
export function db() {
    if (!instance)
        throw new Error("DB not opened");
    return instance;
}
/**
 * Adopts another encrypted database file as this PC's database, with its own key (used when a pharmacy PC takes the
 * copy the main server sent it): closes the current one, installs the new file and key, reopens and migrates.
 */
export function adoptDatabase(newFile, newKey, saveKeyFile) {
    const cur = db();
    const file = cur.file;
    new Db(newFile, newKey).close(); // verify the key opens it before replacing anything
    cur.close();
    for (const ext of ["-wal", "-shm"])
        rmSync(file + ext, { force: true });
    rmSync(file + ".previous", { force: true });
    if (existsSync(file))
        renameSync(file, file + ".previous");
    renameSync(newFile, file);
    saveKeyFile(newKey);
    const next = new Db(file, newKey);
    next.migrate();
    instance = next;
    return next;
}
/**
 * Replaces the open database with another encrypted file (same key), e.g. a fresh replica or an uploaded database:
 * closes the current one, moves the new file into place (the old one is kept as <file>.previous), reopens and migrates.
 */
export function replaceDb(newFile) {
    const cur = db();
    const file = cur.file, key = cur.key;
    // Check the new file opens with this key before touching the live one.
    new Db(newFile, key).close();
    cur.close();
    for (const ext of ["-wal", "-shm"])
        rmSync(file + ext, { force: true });
    rmSync(file + ".previous", { force: true });
    if (existsSync(file))
        renameSync(file, file + ".previous");
    renameSync(newFile, file);
    const next = new Db(file, key);
    next.migrate();
    instance = next;
    return next;
}
