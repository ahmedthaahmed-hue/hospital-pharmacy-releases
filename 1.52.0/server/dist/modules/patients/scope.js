import { HttpError, bad, notFound } from "../../lib/http.js";
import { now as clockNow } from "../../lib/time.js";
export const CHILD_AGE_CUTOFF = 18; // legacy Module5
/** Whole years between DOB and `today` (birthday-not-reached adjusted, min 0). Non-date → null. */
export function ageYears(dob, today = clockNow()) {
    if (!dob)
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
    if (!m)
        return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    let a = today.getFullYear() - y;
    const tm = today.getMonth() + 1, td = today.getDate();
    if (tm < mo || (tm === mo && td < d))
        a--;
    return Math.max(0, a);
}
/** Legacy IsChild: age < 18; no DOB → false. */
export function isChildFromDob(dob, today = clockNow()) {
    const a = ageYears(dob, today);
    return a !== null && a < CHILD_AGE_CUTOFF;
}
export const PATIENT_SELECT = `
  SELECT p.*, d.name AS department, d.location_id AS location_id, l.name AS location_name
  FROM patients p
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN locations l ON l.id = d.location_id`;
/** Patient row regardless of location (or undefined). */
export function findPatient(db, id) {
    return db.get(`${PATIENT_SELECT} WHERE p.id = ?`, [id]);
}
/** Patient of the current pharmacy, active or not; 404 if it belongs elsewhere. */
export function patientInLocation(db, id, locationId, opts = {}) {
    const p = findPatient(db, id);
    if (!p || p.location_id !== locationId)
        throw notFound("Patient");
    if (opts.activeOnly && !p.active)
        throw new HttpError(409, "Patient is inactive — restore them first");
    return p;
}
/** The department must exist, be active and belong to the current pharmacy (fixes legacy free-text department, §5 #29). */
export function assertLocalDepartment(db, departmentId, locationId) {
    const d = db.get("SELECT id, name, location_id, active FROM departments WHERE id = ?", [departmentId]);
    if (!d)
        throw bad("Department not found");
    if (d.location_id !== locationId)
        throw bad("Choose a department of this pharmacy");
    if (!d.active)
        throw bad("This department is inactive");
    return d;
}
/** API shape (camelCase). isChild is recomputed from DOB on read so a birthday never leaves a stale flag. */
export function patientView(p) {
    return {
        id: p.id, name: p.name, coverage: p.coverage, departmentId: p.department_id, department: p.department,
        locationId: p.location_id, locationName: p.location_name ?? null, status: p.status, diagnosis: p.diagnosis, dob: p.dob,
        age: ageYears(p.dob), isChild: isChildFromDob(p.dob), notes: p.notes, operationId: p.operation_id,
        active: !!p.active, createdAt: p.created_at, updatedAt: p.updated_at,
        sex: p.sex ?? null, weightKg: p.weight_kg ?? null, weightAt: p.weight_at ?? null, heightCm: p.height_cm ?? null, heightAt: p.height_at ?? null,
        bsa: bsa(p.weight_kg, p.height_cm), allergyStatus: (p.allergy_status ?? "unknown"),
    };
}
/** Body surface area in m² (Mosteller: √(height cm × weight kg / 3600)), when both are known. */
export function bsa(weightKg, heightCm) {
    if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0)
        return null;
    return Math.round(Math.sqrt((heightCm * weightKg) / 3600) * 100) / 100;
}
