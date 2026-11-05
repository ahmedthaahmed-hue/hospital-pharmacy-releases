export function recordsMigration(db) {
    const have = db.all("PRAGMA table_info(items)").map((c) => c.name);
    // controlled: null (not controlled) | 'narcotic' (Table 1 of Law 182/1960) | 'psychotropic' (Table 2/3, sleep and nerve medicines)
    if (!have.includes("controlled"))
        db.raw.exec("ALTER TABLE items ADD COLUMN controlled TEXT");
    db.raw.exec(`
  -- a counted check of a controlled medicine's balance, with a second person as witness
  CREATE TABLE IF NOT EXISTS cd_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES items(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    at TEXT NOT NULL,
    expected REAL NOT NULL,
    counted REAL NOT NULL,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    witness_id INTEGER REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS ix_cd_checks ON cd_checks(location_id, item_id, at);
  CREATE TABLE IF NOT EXISTS fridges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    name TEXT NOT NULL,
    min_c REAL NOT NULL DEFAULT 2,
    max_c REAL NOT NULL DEFAULT 8,
    readings_per_day INTEGER NOT NULL DEFAULT 2,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fridge_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fridge_id INTEGER NOT NULL REFERENCES fridges(id),
    at TEXT NOT NULL,
    temp_c REAL NOT NULL,
    min_c REAL, max_c REAL,              -- the min / max thermometer since the last reading, when it has one
    out_of_range INTEGER NOT NULL DEFAULT 0,
    action TEXT,                         -- what was done about a reading out of range
    user_id INTEGER REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS ix_fridge_readings ON fridge_readings(fridge_id, at);
  CREATE TABLE IF NOT EXISTS carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    department_id INTEGER REFERENCES departments(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'emergency',   -- emergency | ward_stock
    check_every_days INTEGER NOT NULL DEFAULT 30,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cart_items (
    cart_id INTEGER NOT NULL REFERENCES carts(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    par_qty REAL NOT NULL,
    PRIMARY KEY (cart_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS cart_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL REFERENCES carts(id),
    at TEXT NOT NULL,
    seal_no TEXT,
    status TEXT NOT NULL,                -- ok | restocked | needs_restock
    note TEXT,
    user_id INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS cart_check_lines (
    check_id INTEGER NOT NULL REFERENCES cart_checks(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    present REAL NOT NULL,
    expired REAL NOT NULL DEFAULT 0,     -- of what was present, how much had expired (taken out, replaced)
    nearest_expiry TEXT,
    restocked REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (check_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS interventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    location_id INTEGER REFERENCES locations(id),
    patient_id TEXT REFERENCES patients(id),
    order_id INTEGER,
    item_id TEXT REFERENCES items(id),
    kind TEXT NOT NULL,                  -- see INTERVENTION_KINDS
    problem TEXT NOT NULL,
    recommendation TEXT,
    prescriber TEXT,
    outcome TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | modified | rejected
    significance TEXT,                   -- minor | moderate | major
    user_id INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_interventions_at ON interventions(location_id, at);`);
    // dispensing to a cart or ward stock shows as its own kind in the history
    db.run("INSERT OR IGNORE INTO dispense_types(code, name) VALUES ('cart', 'عربة طوارئ / مخزون قسم')");
    const at = new Date().toISOString();
    const give = (keys, perm) => {
        for (const key of keys) {
            const r = db.get("SELECT id, permissions FROM roles WHERE key = ?", [key]);
            if (!r)
                continue;
            const perms = JSON.parse(r.permissions || "[]");
            if (!perms.includes(perm))
                db.run("UPDATE roles SET permissions = ?, updated_at = ? WHERE id = ?", [JSON.stringify([...perms, perm]), at, r.id]);
        }
    };
    give(["manager", "senior", "pharmacist"], "records");
    give(["manager", "senior"], "records.setup");
}
