// Development only: realistic dispensing activity for the analytics dashboards on the demo database (demo.ts →
// addDemoActivity; a main server set up with "Demo data" gets the same automatically).
//   npx tsx src/db/dev-activity.ts [--db data/pharmacy.sqlite] [--days 120] [--seed 42]
// For every active pharmacy that has departments it writes `dispenses` rows over the last N days for the synthetic
// patients (IDs 9000…) of its departments and the items that have batches there: shift peaks around 06:00 / 12:00 / 18:00,
// a weekend dip (Fri/Sat), a long-tail item popularity (so ABC classes mean something), ~3–6 % returns and walk-in
// tickets. Every row is tagged notes='demo-activity'; re-running first deletes the previous demo rows (idempotent).
// It never changes batches.qty or stock_movements, and refuses to run against a file whose name contains REAL_DATA.
import { basename, resolve } from "node:path";
import { openDb } from "./index.js";
import { addDemoActivity } from "./demo.js";
const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const file = arg("db") ?? process.env.DB_FILE ?? "data/pharmacy.sqlite";
const days = Math.max(1, Math.min(730, Number(arg("days") ?? 120) || 120));
const seed = Number(arg("seed") ?? 42) || 42;
if (/REAL_DATA/i.test(basename(file)) || /REAL_DATA/i.test(resolve(file))) {
    console.error(`refusing to write demo activity into ${file}: the name says it holds real data`);
    process.exit(1);
}
const db = openDb(file);
const res = addDemoActivity(db, { days, seed });
console.log(`dev activity (${days} days, seed ${seed}) → ${file}`);
console.log(`  removed previous demo rows: ${res.removed} dispenses, ${res.removedTickets} walk-in tickets`);
for (const r of res.summary)
    console.log(`  ${r.location}: ${r.skipped ? `skipped (${r.skipped})` : `${r.lines} lines, ${r.returns} returns, ${r.tickets} walk-in tickets`}`);
db.close();
