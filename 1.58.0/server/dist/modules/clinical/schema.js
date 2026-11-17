import { featureOn } from "../../core/feature-gate.js";
import { settingStr } from "../../core/settings.js";
/** The second pharmacist's check that applies: the setting, or "off" when the feature is switched off (Admin → Features). */
export function verificationMode() {
    return featureOn("order_verification") ? settingStr("orders.verification") : "off";
}
/** The order fields a second pharmacist checks: changing any of them takes the order back to "not verified". */
export const VERIFIED_FIELDS = ["item_id", "sec_item_id", "dose", "frequency_hours", "drip_rate", "qty_per_dose", "route", "order_type",
    "start_date", "first_dose_time", "duration_days", "notes"];
export function clinicalMigration(db) {
    const addCols = (table, cols) => {
        const have = db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
        for (const [name, type] of cols)
            if (!have.includes(name))
                db.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    // verification of orders by a second pharmacist (orders written before this release count as verified). written_by:
    // who wrote the order or last changed what is checked — they cannot be its second check. Kept by the triggers below
    // from hps_user() (the user the request works as, db/index.ts), so no route that writes an order can leave it out.
    addCols("medication_orders", [["verified_by", "INTEGER REFERENCES users(id)"], ["verified_at", "TEXT"], ["written_by", "INTEGER REFERENCES users(id)"]]);
    db.run("UPDATE medication_orders SET verified_at = created_at WHERE verified_at IS NULL");
    db.run("UPDATE medication_orders SET written_by = created_by WHERE written_by IS NULL");
    // VEN class of an item: V vital, E essential, N non-essential (WHO)
    addCols("items", [["ven", "TEXT"]]);
    const changed = VERIFIED_FIELDS.map((f) => `NEW.${f} IS NOT OLD.${f}`).join(" OR ");
    db.raw.exec(`
  DROP TRIGGER IF EXISTS tr_orders_unverify;
  CREATE TRIGGER tr_orders_unverify AFTER UPDATE OF ${VERIFIED_FIELDS.join(", ")} ON medication_orders
  FOR EACH ROW WHEN ${changed}
  BEGIN UPDATE medication_orders SET written_by = COALESCE(hps_user(), written_by),
    verified_at = CASE WHEN NEW.verified_at IS OLD.verified_at THEN NULL ELSE NEW.verified_at END,
    verified_by = CASE WHEN NEW.verified_at IS OLD.verified_at THEN NULL ELSE NEW.verified_by END
    WHERE id = NEW.id; END;
  DROP TRIGGER IF EXISTS tr_orders_written;
  CREATE TRIGGER tr_orders_written AFTER INSERT ON medication_orders FOR EACH ROW
  BEGIN UPDATE medication_orders SET written_by = COALESCE(hps_user(), NEW.created_by) WHERE id = NEW.id; END;
  CREATE INDEX IF NOT EXISTS ix_orders_unverified ON medication_orders(verified_at) WHERE verified_at IS NULL;
  CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id, id);`);
    const at = new Date().toISOString();
    for (const key of ["manager", "senior", "pharmacist"]) {
        const r = db.get("SELECT id, permissions FROM roles WHERE key = ?", [key]);
        if (!r)
            continue;
        const perms = JSON.parse(r.permissions || "[]");
        if (!perms.includes("orders.verify"))
            db.run("UPDATE roles SET permissions = ?, updated_at = ? WHERE id = ?", [JSON.stringify([...perms, "orders.verify"]), at, r.id]);
    }
}
