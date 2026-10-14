import { BUILTIN_ROLES, LEGACY_ROLE, levelFor } from "../core/permissions.js";
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
    {
        id: "0006-roles",
        description: "Roles with permissions (core/permissions.ts): the owner, pharmacy manager, senior pharmacist, pharmacist "
            + "and viewer, and the owner's own. The first admin becomes the owner, other admins pharmacy managers, pharmacists "
            + "senior pharmacists (what they could do before) and viewers stay viewers",
        up: (db) => {
            db.raw.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE,                  -- the built-in roles: owner, manager, senior, pharmacist, viewer; NULL for the owner's own
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of permission keys
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
            const cols = db.all("PRAGMA table_info(users)").map((c) => c.name);
            if (!cols.includes("role_id"))
                db.raw.exec("ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)");
            const at = new Date().toISOString();
            BUILTIN_ROLES.forEach((r, i) => db.run("INSERT INTO roles(key, name, description, permissions, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING", [r.key, r.name, r.description, JSON.stringify(r.permissions), i, at, at]));
            const roleId = (key) => db.get("SELECT id FROM roles WHERE key = ?", [key]).id;
            const owner = db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY active DESC, id LIMIT 1");
            for (const [level, key] of Object.entries(LEGACY_ROLE))
                db.run("UPDATE users SET role_id = ? WHERE role_id IS NULL AND role = ?", [roleId(key), level]);
            if (owner)
                db.run("UPDATE users SET role_id = ? WHERE id = ?", [roleId("owner"), owner.id]);
            // the level each role gives (unchanged for these, kept in step from now on by the role routes)
            for (const r of BUILTIN_ROLES)
                db.run("UPDATE users SET role = ? WHERE role_id = ?", [levelFor(r.permissions), roleId(r.key)]);
        },
    },
    {
        id: "0007-safety",
        description: "Patient safety (release 1.4): sex, weight, height and allergies of patients; high-alert and look-alike "
            + "flags and dose limits of items; interaction rules; the log of safety alerts; the 'Maintain clinical safety rules' "
            + "permission for senior pharmacists and pharmacy managers",
        up: (db) => {
            const addCols = (table, cols) => {
                const have = db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
                for (const [name, type] of cols)
                    if (!have.includes(name))
                        db.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
            };
            addCols("patients", [["sex", "TEXT"], ["weight_kg", "REAL"], ["weight_at", "TEXT"], ["height_cm", "REAL"], ["height_at", "TEXT"],
                ["allergy_status", "TEXT NOT NULL DEFAULT 'unknown'"]]);
            addCols("items", [["high_alert", "INTEGER NOT NULL DEFAULT 0"], ["tall_man_name", "TEXT"], ["lasa_group", "TEXT"],
                ["dose_unit", "TEXT"], ["max_single_dose", "REAL"], ["max_daily_dose", "REAL"], ["max_single_per_kg", "REAL"], ["max_daily_per_kg", "REAL"]]);
            addCols("medication_orders", [["double_checked_by", "INTEGER REFERENCES users(id)"]]);
            db.raw.exec(`
      CREATE TABLE IF NOT EXISTS patient_allergies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id TEXT NOT NULL REFERENCES patients(id),
        kind TEXT NOT NULL,                 -- ingredient | class | other
        value TEXT NOT NULL,                -- the active ingredient, the item class, or free text matched against item names
        reaction TEXT,
        severity TEXT NOT NULL DEFAULT 'moderate',   -- mild | moderate | severe
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_patient_allergies ON patient_allergies(patient_id, active);
      CREATE TABLE IF NOT EXISTS interaction_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_kind TEXT NOT NULL,               -- ingredient | class
        a_value TEXT NOT NULL,
        b_kind TEXT NOT NULL,
        b_value TEXT NOT NULL,
        severity TEXT NOT NULL,             -- minor | moderate | major | contraindicated
        message TEXT NOT NULL,
        advice TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS safety_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id),
        location_id INTEGER REFERENCES locations(id),
        patient_id TEXT,
        item_id TEXT,
        kind TEXT NOT NULL,                 -- allergy | interaction | duplicate | dose | high_alert | missing
        level TEXT NOT NULL,                -- info | warning | critical
        message TEXT NOT NULL,
        context TEXT NOT NULL,              -- order.create, order.update, template.apply, kit.apply, walkin.dispense
        action TEXT NOT NULL,               -- overridden (went ahead) | cancelled
        reason TEXT,
        checked_by INTEGER REFERENCES users(id),   -- the second pharmacist of a high-alert double check
        ref TEXT                            -- the order / ticket it was about
      );
      CREATE INDEX IF NOT EXISTS ix_safety_alerts_at ON safety_alerts(at);`);
            const at = new Date().toISOString();
            for (const key of ["manager", "senior"]) {
                const r = db.get("SELECT id, permissions FROM roles WHERE key = ?", [key]);
                if (!r)
                    continue;
                const perms = JSON.parse(r.permissions || "[]");
                if (!perms.includes("safety.rules"))
                    db.run("UPDATE roles SET permissions = ?, updated_at = ? WHERE id = ?", [JSON.stringify([...perms, "safety.rules"]), at, r.id]);
            }
        },
    },
    {
        id: "0008-barcodes",
        description: "Barcodes and traceability (release 1.5): the barcodes (GTINs) of items, holds on batches (quarantine at "
            + "a pharmacy, or a recall of a lot in every pharmacy), and the pack scanned when a dose was checked before dispensing",
        up: (db) => {
            db.raw.exec(`
      CREATE TABLE IF NOT EXISTS item_barcodes (
        code TEXT PRIMARY KEY,               -- a GTIN as 14 digits (EAN-13 padded), or the code as scanned
        item_id TEXT NOT NULL REFERENCES items(id),
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS ix_item_barcodes_item ON item_barcodes(item_id);
      CREATE TABLE IF NOT EXISTS batch_holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items(id),
        batch_no TEXT NOT NULL,
        location_id INTEGER REFERENCES locations(id),   -- NULL: every pharmacy (a recall)
        kind TEXT NOT NULL,                  -- quarantine | recall
        reason TEXT NOT NULL,
        reference TEXT,                      -- e.g. the Drug Authority's recall notice
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        released_at TEXT,
        released_by INTEGER REFERENCES users(id),
        release_note TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_batch_holds_lot ON batch_holds(item_id, batch_no, active);`);
            const cols = db.all("PRAGMA table_info(dispenses)").map((c) => c.name);
            if (!cols.includes("scan_code"))
                db.raw.exec("ALTER TABLE dispenses ADD COLUMN scan_code TEXT");
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
