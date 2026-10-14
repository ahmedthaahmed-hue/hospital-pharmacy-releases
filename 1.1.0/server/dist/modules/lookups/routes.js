import { db } from "../../db/index.js";
import { allSettings } from "../../core/settings.js";
import { now, toLocalDate } from "../../lib/time.js";
/** Read-only reference data every screen needs, in one call (cached client-side). */
export default async function routes(app) {
    app.get("/", async (req) => {
        const d = db();
        const settings = allSettings();
        return {
            locations: d.all("SELECT id, name, active FROM locations ORDER BY id"),
            departments: d.all("SELECT id, name, location_id AS locationId, active FROM departments ORDER BY name"),
            routes: d.all("SELECT id, name FROM routes WHERE active=1 ORDER BY id"),
            frequencies: d.all("SELECT id, hours, description FROM frequencies ORDER BY hours"),
            doseTimes: d.all("SELECT id, time FROM dose_times ORDER BY time"),
            patientStatuses: d.all("SELECT id, name FROM patient_statuses ORDER BY id"),
            orderTypes: d.all("SELECT code, name, is_regular AS isRegular FROM order_types ORDER BY sort"),
            dispenseTypes: d.all("SELECT code, name FROM dispense_types"),
            settings,
            currentLocationId: req.ctx.locationId,
            // the server's wall clock: clients show "now"/"today" in this time zone, corrected for their clock skew
            server: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() },
        };
    });
    /** Item search for comboboxes: by name, selection name, active ingredient, or code. */
    app.get("/items", async (req) => {
        const q = String(req.query.q ?? "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
        const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`); // % and _ typed by the user are literal ("Lidocaine 2%")
        const like = `%${esc}%`;
        return db().all(`SELECT i.id, i.name, i.selection_name AS selectionName, i.strength, i.strength_unit AS strengthUnit, i.unit, i.form,
              i.default_dose AS defaultDose, i.default_frequency AS defaultFrequency, i.default_route AS defaultRoute,
              i.default_notes AS defaultNotes, i.special,
              (SELECT COALESCE(SUM(b.qty),0) FROM batches b WHERE b.item_id=i.id AND b.location_id=? AND b.qty>0
                 AND (b.expiry_date IS NULL OR b.expiry_date >= ?)) AS available
       FROM items i WHERE i.active=1 AND (?='' OR i.name LIKE ? ESCAPE '\\' OR i.selection_name LIKE ? ESCAPE '\\'
         OR i.active_ingredient LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN i.name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, i.name LIMIT ?`, [req.ctx.locationId, toLocalDate(now()), q, like, like, like, like, `${esc}%`, limit]);
    });
}
