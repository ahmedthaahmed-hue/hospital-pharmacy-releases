/** Numeric ids of rows created by this PC while it works offline start here (see platform/ids.ts). */
export const OFFLINE_ID_BASE = 2 ** 48;
export const MIGRATIONS = [
    {
        id: "0001-autoincrement",
        description: "Integer ids never reuse numbers and can be moved into a reserved range (offline pharmacy PCs)",
        up: (db) => ensureAutoincrement(db),
    },
    {
        id: "0002-network",
        description: "Pharmacy PCs registered with this main server, replayed offline work and sync problems",
        up: (db) => db.raw.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_uuid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        location_id INTEGER REFERENCES locations(id),
        token_hash TEXT NOT NULL,
        sync_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        registered_at TEXT NOT NULL,
        registered_by INTEGER REFERENCES users(id),
        last_seen_at TEXT, last_ip TEXT, version TEXT,
        pending_ops INTEGER NOT NULL DEFAULT 0, failed_ops INTEGER NOT NULL DEFAULT 0,
        offline_since TEXT, last_sync_at TEXT
      );
      -- Write requests that carried an operation id (x-op-id): a repeat returns the first answer instead of running twice.
      CREATE TABLE IF NOT EXISTS applied_ops (
        op_id TEXT PRIMARY KEY,
        node_id INTEGER,
        applied_at TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_applied_ops_at ON applied_ops(applied_at);
      -- Offline work a pharmacy PC could not replay on the main server (shown to admins until resolved).
      CREATE TABLE IF NOT EXISTS sync_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        op_id TEXT NOT NULL,
        at TEXT NOT NULL,
        user_id INTEGER,
        method TEXT NOT NULL, url TEXT NOT NULL, body TEXT,
        status INTEGER, error TEXT,
        reported_at TEXT NOT NULL,
        resolved_at TEXT, resolved_by INTEGER, resolution TEXT,
        UNIQUE (node_id, op_id)
      );`),
    },
    {
        id: "0003-outbox",
        description: "A pharmacy PC's log of work to replay on the main server, and its sync state",
        up: (db) => db.raw.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        user_id INTEGER, location_id INTEGER,
        method TEXT NOT NULL, url TEXT NOT NULL, body TEXT,
        created_at TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      -- Offline work the main server rejected (4xx): kept so the pharmacist can see what needs re-entering.
      CREATE TABLE IF NOT EXISTS sync_failures (
        op_id TEXT PRIMARY KEY,
        at TEXT NOT NULL, user_id INTEGER, method TEXT NOT NULL, url TEXT NOT NULL, body TEXT,
        status INTEGER, error TEXT, reported INTEGER NOT NULL DEFAULT 0, failed_at TEXT NOT NULL
      );`),
    },
    {
        id: "0004-dispense-item-index",
        description: "Dispense history by item: dead stock, the item drill-down and item references read one item's rows "
            + "instead of every dispense of the pharmacy (dead stock took over a minute on two years of history)",
        up: (db) => db.raw.exec("CREATE INDEX IF NOT EXISTS ix_dispenses_item ON dispenses(item_id, location_id, at)"),
    },
    {
        id: "0005-replay-ids",
        description: "Rows a pharmacy PC created offline are matched to the rows the main server created for the same work",
        up: (db) => {
            // pharmacy PC: the ids of the rows each queued write created here, as JSON [[table, id], ...]. (Checked first: a
            // stop between this and the migration's record must not make the next start fail on a duplicate column.)
            // uuids: the run ids it generated here, in order (the main server gives its runs the same ids); outcome: what it
            // dispensed here, to compare with what the main server could dispense.
            const cols = db.all("PRAGMA table_info(outbox)").map((c) => c.name);
            for (const c of ["created", "uuids", "outcome"])
                if (!cols.includes(c))
                    db.raw.exec(`ALTER TABLE outbox ADD COLUMN ${c} TEXT`);
            db.raw.exec(`
      -- pharmacy PC: an id made here -> the id the main server gave the same row; active once this PC's copy has the
      -- main server's rows, so a screen still showing the id made here keeps working after the copy is refreshed
      CREATE TABLE IF NOT EXISTS id_aliases (
        local_id INTEGER NOT NULL,
        main_id INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        PRIMARY KEY (local_id)
      );
      -- main server: the id a pharmacy PC gave a row it created offline -> the id the main server gave the same row
      CREATE TABLE IF NOT EXISTS replay_ids (
        node_id INTEGER NOT NULL,
        local_id INTEGER NOT NULL,
        main_id INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        mapped_at TEXT NOT NULL,
        PRIMARY KEY (node_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS ix_replay_ids_at ON replay_ids(mapped_at);`);
        },
    },
];
export function runVersionedMigrations(db) {
    db.raw.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)");
    for (const m of MIGRATIONS) {
        const key = `migration:${m.id}`;
        if (db.get("SELECT 1 FROM schema_meta WHERE key = ?", [key]))
            continue;
        m.up(db);
        db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [key, new Date().toISOString()]);
    }
    // Tables added to schema.sql later get the same treatment.
    ensureAutoincrement(db);
}
const INT_PK = /(\bid\s+INTEGER\s+PRIMARY\s+KEY)(?!\s+AUTOINCREMENT)/i;
/**
 * Rebuilds every table whose `id INTEGER PRIMARY KEY` lacks AUTOINCREMENT (SQLite's documented 12-step procedure), so
 * ids come from sqlite_sequence. Data, indexes and foreign keys are kept.
 */
export function ensureAutoincrement(db) {
    const tables = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
        .filter((t) => INT_PK.test(t.sql));
    if (!tables.length)
        return;
    const raw = db.raw;
    raw.pragma("foreign_keys = OFF");
    raw.pragma("legacy_alter_table = ON");
    try {
        db.tx(() => {
            for (const t of tables) {
                const extras = db.all("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL", [t.name]);
                const tmp = `__rebuild_${t.name}`;
                const createSql = t.sql
                    .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?)[A-Za-z0-9_]+\2/i, `CREATE TABLE "${tmp}"`)
                    .replace(INT_PK, "$1 AUTOINCREMENT");
                raw.exec(createSql);
                raw.exec(`INSERT INTO "${tmp}" SELECT * FROM "${t.name}"`);
                raw.exec(`DROP TABLE "${t.name}"`);
                raw.exec(`ALTER TABLE "${tmp}" RENAME TO "${t.name}"`);
                for (const x of extras)
                    raw.exec(x.sql);
            }
        });
    }
    finally {
        raw.pragma("legacy_alter_table = OFF");
        raw.pragma("foreign_keys = ON");
    }
}
