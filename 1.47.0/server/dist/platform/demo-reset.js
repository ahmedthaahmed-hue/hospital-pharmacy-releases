// The demo hospital starts every day afresh (release 1.17): at midnight a main server running the demo data goes back
// to the default demo, with today's dates — whatever visitors added or changed (patients, departments, accounts,
// settings, stock) is gone. A demo whose midnight was missed (the PC was off) catches up a minute after it starts.
//
// How: a new, empty database (same key) is built next to the live one; what must survive is copied into it — the
// owner's accounts (so the owner can sign in again; every session ends), this server's licence, keys and identity
// (schema_meta), and the pharmacy PCs connected to it (nodes) — it replaces the live database (the old one is kept as
// <file>.previous), and the demo data is loaded into it exactly as the first-run "Demo data" choice does. Requests
// that arrive meanwhile are told to try again in a minute. Never runs on anything but a demo main server.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Db, db, replaceDb } from "../db/index.js";
import { isDemo } from "../db/demo.js";
import { nowIso, toLocalDate } from "../lib/time.js";
import { loadFirstData } from "./first-run.js";
import { nodeConfig } from "./node-config.js";
import { appRoot } from "./paths.js";
let resetting = false;
/** True while the demo is being rebuilt (app.ts answers requests 503 meanwhile). */
export const demoResetting = () => resetting;
/** Copies the rows of `table` matching `where` from one database to another (the columns both have; `set` overrides some). */
function copyRows(from, to, table, where = "1 = 1", args = [], set = {}) {
    const cols = (d) => new Set(d.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    const theirs = cols(to);
    const shared = [...cols(from)].filter((c) => theirs.has(c));
    if (!shared.length)
        return 0;
    let n = 0;
    for (const r of from.all(`SELECT ${shared.join(",")} FROM ${table} WHERE ${where}`, args)) {
        to.run(`INSERT OR IGNORE INTO ${table}(${shared.join(",")}) VALUES (${shared.map(() => "?").join(",")})`, shared.map((c) => (c in set ? set[c] : r[c]) ?? null));
        n++;
    }
    return n;
}
/** Rebuilds the demo hospital from the demo data. Returns what the fresh demo holds. */
export async function resetDemo(now = new Date()) {
    if (nodeConfig().role !== "server" || !isDemo(db))
        throw new Error("Only a demo main server resets itself");
    if (!existsSync(join(appRoot(), "db", "pharmacy_demo.sqlite")))
        throw new Error("The demo data is not part of this install");
    if (resetting)
        throw new Error("The demo is already being reset");
    resetting = true;
    try {
        const cur = db();
        const tmp = `${cur.file}.demo-reset`;
        for (const ext of ["", "-wal", "-shm"])
            rmSync(tmp + ext, { force: true });
        const fresh = new Db(tmp, cur.key);
        let keptOwners = 0;
        try {
            fresh.migrate();
            // the rows kept point at pharmacies and accounts the demo import brings back with the same IDs: checked by then
            fresh.raw.pragma("foreign_keys = OFF");
            fresh.tx(() => {
                // this server's identity, licence, keys and update state; the new database's own bookkeeping wins
                copyRows(cur, fresh, "schema_meta");
                copyRows(cur, fresh, "nodes");
                copyRows(cur, fresh, "fleet_hospitals");
                // the owner's accounts, with the owner role of the new database (everyone signs in again afterwards)
                const ownerRole = (d) => d.get("SELECT id FROM roles WHERE key = 'owner'")?.id ?? null;
                const owners = cur.all("SELECT id FROM users WHERE role_id = ?", [ownerRole(cur)]).map((u) => u.id);
                for (const id of owners) {
                    copyRows(cur, fresh, "users", "id = ?", [id], { role_id: ownerRole(fresh) });
                }
                keptOwners = owners.length;
            });
        }
        finally {
            fresh.close();
        }
        replaceDb(tmp);
        const r = await loadFirstData({ kind: "demo" });
        db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "demo.reset", "system", JSON.stringify({ day: toLocalDate(now), keptOwners, counts: r.counts })]);
        const patients = db().get("SELECT COUNT(*) AS n FROM patients WHERE active = 1")?.n ?? 0;
        return { patients, keptOwners };
    }
    finally {
        resetting = false;
    }
}
/** Milliseconds to the next local midnight (plus half a minute, clear of the day change). */
export function msToMidnight(now = new Date()) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
    return next.getTime() - now.getTime();
}
/** Whether the demo was last made current on an earlier day than today (a missed midnight). */
export function demoIsStale(now = new Date()) {
    const day = db().get("SELECT value FROM schema_meta WHERE key = 'demo_day'")?.value;
    return day !== toLocalDate(now);
}
/** Main server: reset the demo each midnight, and once soon after starting if a midnight was missed. */
export function startDemoResetSchedule() {
    const run = () => { if (isDemo(db))
        void resetDemo().catch((e) => console.error("demo reset failed:", e?.message ?? e)); };
    const schedule = () => setTimeout(() => { run(); schedule(); }, msToMidnight()).unref();
    schedule();
    setTimeout(() => { if (isDemo(db) && demoIsStale())
        run(); }, 60_000).unref();
}
