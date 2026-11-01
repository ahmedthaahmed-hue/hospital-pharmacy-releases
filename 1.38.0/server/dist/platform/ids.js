import { OFFLINE_ID_BASE } from "../db/versioned.js";
import { nodeConfig, updateNodeConfig } from "./node-config.js";
/** Ids per table slice (16.7 million rows made on one PC per table); 256 slices fill the PC's range of 2^32. */
export const OFFLINE_SLICE = 2 ** 24;
const SLICES = 256;
/** First id this PC uses for new rows: 2^48 + nodeId * 2^32 (stays below 2^53, so ids remain exact JS numbers). */
export const offlineIdBase = (nodeId) => OFFLINE_ID_BASE + (nodeId % 2 ** 20) * 2 ** 32;
/** Whether `id` was made on the PC with this node id. */
export const isOfflineId = (nodeId, id) => id >= offlineIdBase(nodeId) && id < offlineIdBase(nodeId) + 2 ** 32;
/**
 * Replaces each id made on `nodeId`'s PC that appears in `text` (an address or a JSON body) by lookup(id), where it has
 * one. Only whole numbers in that PC's own range are candidates (15–16 digits, ≥ 2^48), so quantities, batch numbers
 * and other ids are never touched.
 */
export function rewriteOfflineIds(text, nodeId, lookup) {
    if (!/\d{15}/.test(text))
        return text;
    return text.replace(/(?<![\d.])\d{15,16}(?![\d.])/g, (s) => {
        const n = Number(s);
        if (!isOfflineId(nodeId, n))
            return s;
        const m = lookup(n);
        return m === undefined ? s : String(m);
    });
}
/** The slice of each table (kept in node.json, so a table keeps its slice across database copies and new tables). */
function slices(tables) {
    const have = { ...(nodeConfig().offlineSlices ?? {}) };
    let next = Math.max(-1, ...Object.values(have)) + 1;
    let changed = false;
    for (const t of [...tables].sort())
        if (have[t] === undefined) {
            have[t] = next++ % SLICES;
            changed = true;
        }
    if (changed)
        updateNodeConfig({ offlineSlices: have });
    return have;
}
/** The AUTOINCREMENT counters at or above `nodeId`'s range (read before a copy replaces them, see reserveOfflineIds). */
export function offlineCounters(db, nodeId) {
    const out = {};
    for (const r of db.all("SELECT name, seq FROM sqlite_sequence"))
        if (isOfflineId(nodeId, r.seq))
            out[r.name] = r.seq;
    return out;
}
/**
 * Moves every AUTOINCREMENT counter of this database into the PC's own slice for that table (never backwards). `keep`:
 * the counters before a fresh copy replaced the database, so ids made here are never handed out twice.
 */
export function reserveOfflineIds(db, nodeId, keep = {}) {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql LIKE '%AUTOINCREMENT%'").map((t) => t.name);
    const slice = slices(tables);
    db.tx(() => {
        for (const name of tables) {
            const start = offlineIdBase(nodeId) + slice[name] * OFFLINE_SLICE;
            const floor = keep[name] >= start && keep[name] < start + OFFLINE_SLICE ? keep[name] : start;
            db.run("INSERT INTO sqlite_sequence(name, seq) SELECT ?, 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)", [name, name]);
            db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?", [floor, name, floor]);
        }
    });
}
