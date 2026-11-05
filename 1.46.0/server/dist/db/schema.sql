-- Hospital Pharmacy System — application schema (SQLite).
-- Replaces the legacy Access backend. See docs/FEATURES.md for the legacy behaviour each table supports.
-- Conventions: snake_case, INTEGER PKs unless the business key is the identity (patients.id, items.id),
-- timestamps as ISO-8601 local time text 'YYYY-MM-DDTHH:MM:SS', dates 'YYYY-MM-DD', times 'HH:MM'.
-- Quantities are REAL (legacy forced integers, which made 0.5 doses dispense 0).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

-- ---------- Organisation ----------
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location_id INTEGER REFERENCES locations(id),   -- NULL = not assigned to a pharmacy (patients hidden from lists)
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','pharmacist','viewer')),
  location_id INTEGER REFERENCES locations(id),          -- home location; admins may switch
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),  -- the pharmacy this session works as
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  location_id INTEGER,
  action TEXT NOT NULL,            -- e.g. 'patient.create', 'dispense', 'batch.receive'
  entity TEXT,
  entity_id TEXT,
  details TEXT                     -- JSON
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- Lookups ----------
CREATE TABLE IF NOT EXISTS routes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS frequencies (id INTEGER PRIMARY KEY, hours REAL NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS dose_times (id INTEGER PRIMARY KEY, time TEXT NOT NULL UNIQUE);           -- 'HH:MM'
CREATE TABLE IF NOT EXISTS patient_statuses (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS order_types (
  code TEXT PRIMARY KEY,           -- regular | cont_drip | once | care | operation
  name TEXT NOT NULL,              -- display (Arabic/English as used on the ward)
  is_regular INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dispense_types (
  code TEXT PRIMARY KEY,           -- run_24h | selected_times | midday | drip | manual | walkin | return
  name TEXT NOT NULL,              -- Arabic label
  legacy_name TEXT                 -- legacy DispenseHistory.DispenseType literal
);

-- ---------- Catalogue ----------
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,             -- 'A00529'
  item_no INTEGER NOT NULL UNIQUE, -- legacy [رقم الصنف]
  name TEXT NOT NULL,
  selection_name TEXT,             -- legacy [ItemSelection name], shown in order lists
  active_ingredient TEXT,          -- legacy AC
  strength TEXT,                   -- legacy [التركيز - الحجم]
  strength_unit TEXT,              -- legacy ConcUnit
  form TEXT,
  class TEXT,
  type TEXT,
  unit TEXT,
  special TEXT,
  default_dose TEXT,
  default_frequency REAL,
  default_route TEXT,
  default_notes TEXT,
  use_window TEXT,
  custody_page INTEGER,            -- legacy [صفحة دفتر العهدة]
  active INTEGER NOT NULL DEFAULT 1
);

-- ---------- Patients ----------
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY,
  op_no TEXT,
  name TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),   -- NULL = all locations
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,             -- hospital patient ID as entered by staff
  name TEXT NOT NULL,
  coverage TEXT,
  department_id INTEGER REFERENCES departments(id),
  status TEXT,                     -- free text from patient_statuses
  diagnosis TEXT,
  dob TEXT,
  is_child INTEGER NOT NULL DEFAULT 0,   -- age < 18, recomputed on save
  notes TEXT,                      -- alert notes; shown as alert box on labels
  operation_id INTEGER REFERENCES operations(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_patients_dept ON patients(department_id, active);

-- ---------- Stock ----------
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  batch_no TEXT NOT NULL,
  expiry_date TEXT,                -- NULL = no expiry (dispensed last)
  qty REAL NOT NULL DEFAULT 0 CHECK (qty >= 0),
  is_placeholder INTEGER NOT NULL DEFAULT 0,  -- TEMP stock so wards can dispense before real stock is entered
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_batches_key ON batches(item_id, location_id, batch_no, IFNULL(expiry_date, ''));
CREATE INDEX IF NOT EXISTS ix_batches_item_loc ON batches(item_id, location_id);

-- Every change to batches.qty writes one movement row (legacy had none).
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  kind TEXT NOT NULL CHECK (kind IN ('receive','dispense','return','adjust','placeholder','import')),
  qty_delta REAL NOT NULL,
  dispense_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_movements_batch ON stock_movements(batch_id);

-- ---------- Orders ----------
CREATE TABLE IF NOT EXISTS medication_orders (
  id INTEGER PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  sec_item_id TEXT REFERENCES items(id),       -- diluent / additive shown on drip labels
  dose TEXT,
  frequency_hours REAL,                         -- hours between doses
  drip_rate REAL,                               -- mL/h for continuous drips
  qty_per_dose REAL NOT NULL DEFAULT 1,
  total_daily_qty REAL,
  route TEXT,
  order_type TEXT NOT NULL REFERENCES order_types(code),
  start_date TEXT NOT NULL,                     -- 'YYYY-MM-DD'
  first_dose_time TEXT NOT NULL DEFAULT '06:00',-- 'HH:MM'
  duration_days REAL,                           -- NULL = open-ended
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hold','stopped')),
  notes TEXT,
  next_dispense_at TEXT,                        -- drip calculator result
  display_order INTEGER NOT NULL DEFAULT 0,
  is_auto_from_operation INTEGER NOT NULL DEFAULT 0,
  source_operation_id INTEGER REFERENCES operations(id),
  source_kit_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_patient ON medication_orders(patient_id, order_type, display_order);

-- ---------- Dispensing ----------
-- One row per batch touched (same as legacy DispenseHistory). Returns are positive qty with type 'return'.
CREATE TABLE IF NOT EXISTS dispenses (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  patient_id TEXT,                 -- inpatient ID or walk-in free-text ID; NULL = no patient
  patient_name TEXT,               -- snapshot (walk-ins have no patients row)
  order_id INTEGER REFERENCES medication_orders(id) ON DELETE SET NULL,
  walkin_ticket_id INTEGER,
  item_id TEXT NOT NULL REFERENCES items(id),
  batch_id INTEGER REFERENCES batches(id),
  qty REAL NOT NULL,
  type TEXT NOT NULL REFERENCES dispense_types(code),
  user_id INTEGER REFERENCES users(id),
  run_id TEXT,                     -- groups rows of one action (one FEFO call / one 24h run)
  notes TEXT
);
CREATE INDEX IF NOT EXISTS ix_dispenses_at ON dispenses(location_id, at);
CREATE INDEX IF NOT EXISTS ix_dispenses_patient ON dispenses(patient_id, item_id);
CREATE INDEX IF NOT EXISTS ix_dispenses_order ON dispenses(order_id);

-- Idempotency for scheduled doses: a dose slot of an order can be dispensed once.
-- (Legacy had no guard: re-running the 24h print dispensed again.)
CREATE TABLE IF NOT EXISTS dispensed_slots (
  order_id INTEGER NOT NULL REFERENCES medication_orders(id) ON DELETE CASCADE,
  slot_at TEXT NOT NULL,           -- dose datetime 'YYYY-MM-DDTHH:MM'
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (order_id, slot_at)
);

-- ---------- Templates & kits ----------
CREATE TABLE IF NOT EXISTS order_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS order_template_lines (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES order_templates(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  sec_item_id TEXT REFERENCES items(id),
  dose TEXT,
  qty_per_dose REAL,
  frequency_hours REAL,
  drip_rate REAL,
  route TEXT,
  duration_days REAL,
  order_type TEXT,
  notes TEXT,
  first_dose_time TEXT,
  display_offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operation_kits (
  id INTEGER PRIMARY KEY,
  operation_id INTEGER NOT NULL REFERENCES operations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  UNIQUE (operation_id, location_id)
);
CREATE TABLE IF NOT EXISTS operation_kit_lines (
  id INTEGER PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES operation_kits(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  default_qty REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS operation_kit_exclusions (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT
);

-- ---------- Walk-ins ----------
CREATE TABLE IF NOT EXISTS rx_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rx_template_lines (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES rx_templates(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 0,
  item_id TEXT NOT NULL REFERENCES items(id),
  qty REAL NOT NULL DEFAULT 1,
  notes TEXT,
  route TEXT,
  conc TEXT,
  unit TEXT
);

CREATE TABLE IF NOT EXISTS walkin_tickets (
  id INTEGER PRIMARY KEY,          -- ticket number
  created_at TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  patient_ref TEXT,                -- free-text ID (walk-ins are not in patients)
  patient_name TEXT,
  user_id INTEGER REFERENCES users(id),
  dispensed_at TEXT
);
CREATE TABLE IF NOT EXISTS walkin_lines (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES walkin_tickets(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id TEXT REFERENCES items(id),
  route TEXT,
  conc TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 1,
  notes TEXT,
  to_dispense INTEGER NOT NULL DEFAULT 1,
  to_print INTEGER NOT NULL DEFAULT 1,
  dispensed_qty REAL NOT NULL DEFAULT 0,   -- guards against dispensing the same line twice
  created_at TEXT NOT NULL
);

-- ---------- Chat ----------
CREATE TABLE IF NOT EXISTS chat_rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id),
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),   -- NULL = everyone
  from_user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_presence (
  location_id INTEGER PRIMARY KEY REFERENCES locations(id),
  last_seen TEXT NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0
);

-- ---------- runs (slice C): 24 h / selected-times print & dispense runs ----------
-- One row per run so its summary can be reopened and its labels reprinted without dispensing again.
-- id = the run_id written on dispenses / dispensed_slots by that run.
CREATE TABLE IF NOT EXISTS dispense_runs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  mode TEXT NOT NULL,              -- day | selected_times | patient_labels
  params TEXT NOT NULL,            -- JSON: request inputs (date, doseTimes, scope, orderTypes, dispense, print …)
  summary TEXT NOT NULL,           -- JSON: counts + per-order outcome lines
  labels TEXT                      -- JSON: label data as printed (batch/expiry of what was actually dispensed)
);
CREATE INDEX IF NOT EXISTS ix_dispense_runs_loc ON dispense_runs(location_id, at);
CREATE INDEX IF NOT EXISTS ix_dispensed_slots_slot ON dispensed_slots(slot_at);

-- ---------- walk-in / rx-templates / order-templates / operations (slice D) ----------
CREATE INDEX IF NOT EXISTS ix_walkin_tickets_loc ON walkin_tickets(location_id, created_at);
CREATE INDEX IF NOT EXISTS ix_walkin_lines_ticket ON walkin_lines(ticket_id, line_no);
CREATE INDEX IF NOT EXISTS ix_dispenses_walkin ON dispenses(walkin_ticket_id);
CREATE INDEX IF NOT EXISTS ix_rx_template_lines_tpl ON rx_template_lines(template_id, line_no);
CREATE INDEX IF NOT EXISTS ix_order_template_lines_tpl ON order_template_lines(template_id, display_offset);
CREATE INDEX IF NOT EXISTS ix_kit_lines_kit ON operation_kit_lines(kit_id);
CREATE INDEX IF NOT EXISTS ix_kit_exclusions_loc ON operation_kit_exclusions(location_id, item_id);

-- ---------- admin / chat (slice E) ----------
CREATE INDEX IF NOT EXISTS ix_chat_messages_room ON chat_messages(room_id, id);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action, id);
CREATE INDEX IF NOT EXISTS ix_audit_user ON audit_log(user_id, id);

-- ---------- orders: schedule edits after a day's doses were dispensed ----------
-- Dose slots are keyed by order + dose time, so changing an order's item, frequency, first dose time or qty per dose
-- after doses of a medical day were dispensed makes that day look undispensed (or, for a new item, dispensed). One row
-- per order and affected medical day: runs skip the order for that day and a manual dispense needs force.
CREATE TABLE IF NOT EXISTS order_edits_after_dispense (
  order_id INTEGER NOT NULL REFERENCES medication_orders(id) ON DELETE CASCADE,
  medical_day TEXT NOT NULL,       -- 'YYYY-MM-DD' = the date the medical day starts on
  at TEXT NOT NULL,
  PRIMARY KEY (order_id, medical_day)
);

-- ---------- layouts: screens, tables and labels arranged by admins and users ----------
-- One saved arrangement per scope and key. Keys: 'screen:<name>' (panels), 'nav' (sidebar order), 'table:<name>'
-- (columns), 'label:<report>' (label fields). scope_id: 0 for the hospital, the pharmacy's id, or the user's id.
-- "This PC" layouts are kept in the browser of that PC, not here.
CREATE TABLE IF NOT EXISTS ui_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('hospital', 'location', 'user')),
  scope_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  data TEXT NOT NULL,              -- JSON, its shape depends on the key (web/src/layout/)
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (scope, scope_id, key)
);

-- The owner's fleet view (release 1.13, platform/fleet.ts): the latest report from each hospital's main server — its
-- version, licence and health, never patient data. Kept only on the owner's own server, where receiving is turned on.
CREATE TABLE IF NOT EXISTS fleet_hospitals (
  machine TEXT PRIMARY KEY,         -- the reporting main server's machine code
  key TEXT NOT NULL,                -- its reporting key (sent with its first report; later reports are signed with it)
  hospital TEXT,
  version TEXT,
  overall TEXT,                     -- ok | warn | danger
  report TEXT NOT NULL,             -- JSON: the whole report
  ip TEXT,
  approved INTEGER NOT NULL DEFAULT 0,   -- the owner recognised it (a new machine waits: someone else may have its code)
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- The hospital system link (release 1.14, modules/his/): what the hospital's own system (HIS) sent — admissions,
-- transfers, discharges (applied at once) and doctors' medication orders (waiting for a pharmacist to accept, which makes
-- a real order with every safety check, or to reject).
CREATE TABLE IF NOT EXISTS his_messages (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  source TEXT,                      -- the file it came in, or "upload"
  format TEXT NOT NULL,             -- csv | hl7 | fhir
  kind TEXT NOT NULL,               -- admit | transfer | discharge | order | cancel | unreadable
  patient_id TEXT,
  ref TEXT,                         -- the hospital system's order or visit number
  status TEXT NOT NULL,             -- applied | pending | accepted | rejected | cancelled | error | skipped
  data TEXT NOT NULL,               -- JSON: the message as read (modules/his/parse.ts HisMsg), or the unreadable text
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,    -- orders: the item the drug code maps to
  order_id INTEGER REFERENCES medication_orders(id) ON DELETE SET NULL,   -- the order it became (or that a cancel is about)
  error TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_his_messages_status ON his_messages(status, kind);
CREATE INDEX IF NOT EXISTS ix_his_messages_ref ON his_messages(ref, patient_id);
-- The hospital system's codes for drugs and departments, and what they are here (learned when a pharmacist maps one).
CREATE TABLE IF NOT EXISTS his_maps (
  kind TEXT NOT NULL CHECK (kind IN ('item', 'department')),
  code TEXT NOT NULL,
  target TEXT NOT NULL,             -- items.id, or departments.id
  PRIMARY KEY (kind, code)
);
-- Files read from the hospital system's inbox folder, by content: a file that cannot be moved away (a read-only share)
-- is not read again.
CREATE TABLE IF NOT EXISTS his_files (
  hash TEXT PRIMARY KEY,            -- sha256 of the content
  name TEXT NOT NULL,
  read_at TEXT NOT NULL
);
