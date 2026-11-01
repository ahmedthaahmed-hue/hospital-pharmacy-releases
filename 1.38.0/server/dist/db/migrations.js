import { nowIso } from "../lib/time.js";
export function dataMigrations(db) {
    markLegacyWalkinsDispensed(db);
    legacyLabelSize(db);
}
/**
 * The labels are the legacy Access reports, drawn on a 55 x 55 mm page (docs/label-capture/PAXERA). Databases created
 * before that kept the old placeholder size (60 x 40 / 50 x 30 ...), so the preview showed a wide frame around a square
 * label and printing cut it. Set 55 x 55 once; a size the admin picks afterwards is kept.
 */
export function legacyLabelSize(db) {
    if (db.get("SELECT 1 FROM schema_meta WHERE key = 'label_size_legacy_55'"))
        return;
    db.tx(() => {
        for (const k of ["label.width_mm", "label.height_mm"])
            db.run("INSERT INTO settings(key, value) VALUES (?, '55') ON CONFLICT(key) DO UPDATE SET value = '55'", [k]);
        db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('label_size_legacy_55', ?)", [nowIso()]);
    });
}
/**
 * Walk-in tickets imported from the legacy system were already dispensed there, but importers before this fix stored
 * their lines with dispensed_qty = 0, so pressing dispense on an old ticket took the stock again.
 *
 * Imported tickets are identified by the import itself: the importer wipes walkin_tickets and records the import time in
 * schema_meta.legacy_import_at, so every ticket created at/before that time came from the legacy system (tickets made in
 * this system get created_at = now, after the import). Back-dated tickets that have dispenses in this system (dev demo
 * data), or any dispensed line / dispensed_at, are left alone. Runs once per import (marker key), so later edits of old
 * tickets (e.g. a print-only line switched to dispense) are never touched.
 * Returns the number of tickets marked.
 */
export function markLegacyWalkinsDispensed(db) {
    const importAt = db.get("SELECT value FROM schema_meta WHERE key = 'legacy_import_at'")?.value;
    if (!importAt)
        return 0;
    const done = db.get("SELECT value FROM schema_meta WHERE key = 'legacy_walkins_dispensed_for'")?.value;
    if (done === importAt)
        return 0;
    return db.tx(() => {
        const tickets = db.all(`SELECT t.id FROM walkin_tickets t
       WHERE t.created_at <= ? AND t.dispensed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM dispenses x WHERE x.walkin_ticket_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM walkin_lines l WHERE l.ticket_id = t.id AND l.dispensed_qty > 0)
         AND EXISTS (SELECT 1 FROM walkin_lines l WHERE l.ticket_id = t.id AND l.to_dispense = 1 AND l.item_id IS NOT NULL AND l.qty > 0)`, [importAt]);
        for (const t of tickets) {
            db.run("UPDATE walkin_lines SET dispensed_qty = qty WHERE ticket_id = ? AND to_dispense = 1 AND item_id IS NOT NULL AND qty > 0", [t.id]);
            db.run("UPDATE walkin_tickets SET dispensed_at = created_at WHERE id = ?", [t.id]);
        }
        if (tickets.length)
            db.run("INSERT INTO audit_log(at, action, entity, details) VALUES (?, 'system.legacy_walkins_dispensed', 'walkin_ticket', ?)", [nowIso(), JSON.stringify({ importAt, tickets: tickets.length })]);
        db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('legacy_walkins_dispensed_for', ?)", [importAt]);
        return tickets.length;
    });
}
