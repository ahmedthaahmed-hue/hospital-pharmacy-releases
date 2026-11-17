// The demo hospital starts every day afresh (release 1.17): at midnight a main server running the demo data goes back
// to the demo's patients and dispensing, with today's dates. A demo whose midnight was missed (the PC was off) catches
// up a minute after it starts.
//
// Since 1.55 the hospital's setup is kept (a hospital trying the demo sets it up as its own: the logo, settings, the
// catalogue and kits, the accounts, the phones): only patients, their orders and dispensing, walk-ins, stock and the
// day-to-day records start over (KEPT below lists what stays).
//
// How: a new, empty database (same key) is built next to the live one; what must be there before the demo is loaded
// is copied into it — the owner's accounts, this server's licence, keys and identity (schema_meta), and the pharmacy
// PCs connected to it (nodes) — it replaces the live database (the old one is kept as <file>.previous), and the demo
// data is loaded into it exactly as the first-run "Demo data" choice does. Then the hospital's setup is copied back
// from the old database over the demo's own. Requests that arrive meanwhile are told to try again in a minute. Never
// runs on anything but a demo main server.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Db, db, replaceDb } from "../db/index.js";
import { isDemo } from "../db/demo.js";
import { nowIso, toLocalDate } from "../lib/time.js";
import { loadFirstData } from "./first-run.js";
import { nodeConfig } from "./node-config.js";
import { appRoot } from "./paths.js";
/**
 * The setup kept through the nightly reset, copied back from the old database. "merge": its rows replace the demo's rows
 * with the same key and the demo's others stay (the demo's patients and history point at them); "replace": the old
 * database's rows only (so what was removed stays removed).
 */
export const KEPT = [
    ["settings", "merge"], // the hospital's name, logo, features, defaults
    ["roles", "merge"], ["users", "merge"], ["sessions", "replace"], // accounts and who is signed in (phones need it)
    ["phone_devices", "replace"], ["ui_layouts", "replace"], // linked phones; screen and label layouts
    ["locations", "merge"], ["departments", "merge"],
    ["dispense_types", "merge"], ["dose_times", "merge"], ["frequencies", "merge"], ["order_types", "merge"],
    ["routes", "merge"], ["patient_statuses", "merge"],
    ["items", "merge"], ["item_barcodes", "replace"], ["interaction_rules", "replace"], ["suppliers", "merge"],
    ["operations", "merge"], ["operation_kits", "merge"], ["operation_kit_lines", "replace"], ["operation_kit_exclusions", "replace"],
    ["rx_templates", "merge"], ["rx_template_lines", "replace"], ["order_templates", "merge"], ["order_template_lines", "replace"],
    ["fridges", "merge"], ["carts", "merge"], ["cart_items", "replace"], ["his_maps", "replace"],
];
let resetting = false;
/** True while the demo is being rebuilt (app.ts answers requests 503 meanwhile). */
export const demoResetting = () => resetting;
/** Copies the rows of `table` matching `where` from one database to another (the columns both have; `set` overrides some). */
function copyRows(from, to, table, where = "1 = 1", args = [], set = {}, verb = "INSERT OR IGNORE") {
    const cols = (d) => new Set(d.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    const theirs = cols(to);
    const shared = [...cols(from)].filter((c) => theirs.has(c));
    if (!shared.length)
        return 0;
    let n = 0;
    for (const r of from.all(`SELECT ${shared.join(",")} FROM ${table} WHERE ${where}`, args)) {
        to.run(`${verb} INTO ${table}(${shared.join(",")}) VALUES (${shared.map(() => "?").join(",")})`, shared.map((c) => (c in set ? set[c] : r[c]) ?? null));
        n++;
    }
    return n;
}
/** Copies the hospital's setup (KEPT) from the database before the reset into the fresh demo. */
function keepSetup(from, to) {
    const kept = {};
    const has = (d, t) => !!d.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]);
    // rows are replaced whole: no cascades meanwhile (the result is checked below)
    to.raw.pragma("foreign_keys = OFF");
    try {
        to.tx(() => {
            for (const [t, how] of KEPT) {
                if (!has(from, t) || !has(to, t))
                    continue;
                if (how === "replace")
                    to.run(`DELETE FROM ${t}`);
                kept[t] = copyRows(from, to, t, "1 = 1", [], {}, "INSERT OR REPLACE");
            }
            // the demo's flag and day are the fresh database's own
            to.run("INSERT INTO settings(key,value) VALUES ('system.demo','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
            // anything kept that now points nowhere (a demo pharmacy removed, ...) goes, rather than break the database
            for (const v of to.all("PRAGMA foreign_key_check")) {
                if (KEPT.some(([t]) => t === v.table) && v.rowid != null)
                    to.run(`DELETE FROM ${v.table} WHERE rowid = ?`, [v.rowid]);
            }
        });
    }
    finally {
        to.raw.pragma("foreign_keys = ON");
    }
    return kept;
}
/** Rebuilds the demo hospital from the demo data, keeping the hospital's setup. Returns what the fresh demo holds. */
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
        const before = new Db(`${db().file}.previous`, db().key);
        let kept = {};
        try {
            kept = keepSetup(before, db());
        }
        finally {
            before.close();
        }
        db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "demo.reset", "system", JSON.stringify({ day: toLocalDate(now), keptOwners, counts: r.counts, kept })]);
        const patients = db().get("SELECT COUNT(*) AS n FROM patients WHERE active = 1")?.n ?? 0;
        return { patients, keptOwners, kept };
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
