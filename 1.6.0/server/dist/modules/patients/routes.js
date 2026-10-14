import { z } from "zod";
import { db } from "../../db/index.js";
import { HttpError, audit, bad, can, parse, requirePerm, zDate, zOptStr } from "../../lib/http.js";
import { now as clockNow, nowIso, toLocalDate } from "../../lib/time.js";
import { PATIENT_SELECT, assertLocalDepartment, findPatient, isChildFromDob, patientInLocation, patientView, } from "./scope.js";
const zPatientId = z.string().trim().min(1, "Patient ID is required").max(30, "Patient ID is too long");
const zDob = zDate.nullish().transform((v) => v || null)
    .refine((v) => !v || v <= toLocalDate(clockNow()), "Date of birth cannot be in the future");
/** An optional measurement within sensible limits (blank = not recorded). */
function optMeasure(what, min, max) {
    return z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number({ message: `${what} must be a number` }).finite(`${what} must be a number`)
        .min(min, `${what} looks wrong (at least ${min})`).max(max, `${what} looks wrong (at most ${max})`).nullable()).optional();
}
const patientFields = {
    name: z.string().trim().min(1, "Patient name is required").max(200),
    departmentId: z.coerce.number().int().positive("Choose the department"),
    coverage: zOptStr,
    status: zOptStr,
    diagnosis: zOptStr,
    dob: zDob,
    notes: zOptStr,
    operationId: z.coerce.number().int().positive().nullish().transform((v) => v ?? null),
    sex: z.enum(["M", "F"], { message: "Choose male or female" }).nullish().transform((v) => v ?? null),
    weightKg: optMeasure("Weight", 0.2, 400),
    heightCm: optMeasure("Height", 20, 260),
    allergyStatus: z.enum(["unknown", "nka", "has"], { message: "Invalid allergy status" }).optional(),
};
const createSchema = z.object({ id: zPatientId, ...patientFields });
const updateSchema = z.object(patientFields).partial();
/** LIKE pattern for a typed search: % and _ are literal. */
const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const deptSchema = z.object({ departmentId: z.coerce.number().int().positive("Choose the department") });
export default async function routes(app) {
    /** Active patients of this pharmacy. ?departmentId= &q= (name or hospital ID). */
    app.get("/", async (req) => {
        const q = req.query;
        const where = ["p.active = 1", "d.location_id = ?"];
        const params = [req.ctx.locationId];
        if (q.departmentId) {
            where.push("p.department_id = ?");
            params.push(Number(q.departmentId));
        }
        const term = (q.q ?? "").trim();
        if (term) {
            where.push("(p.name LIKE ? ESCAPE '\\' OR p.id LIKE ? ESCAPE '\\')");
            params.push(like(term), like(term));
        }
        const rows = db().all(`${PATIENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.name COLLATE NOCASE, p.id`, params);
        const counts = new Map(db().all(`SELECT o.patient_id, COUNT(*) n FROM medication_orders o JOIN patients p ON p.id = o.patient_id
       JOIN departments d ON d.id = p.department_id
       WHERE o.status = 'active' AND p.active = 1 AND d.location_id = ? GROUP BY o.patient_id`, [req.ctx.locationId]).map((r) => [r.patient_id, r.n]));
        return rows.map((r) => ({ ...patientView(r), activeOrders: counts.get(r.id) ?? 0 }));
    });
    /**
     * Inactive patients for "restore". scope=local (default): last department belonged to this pharmacy or to none;
     * scope=all: every inactive patient (a returning patient may have been discharged from another pharmacy) — only for
     * those who may see other pharmacies' patients; others see their own pharmacy only, as with stock.
     */
    app.get("/inactive", async (req) => {
        const q = req.query;
        if (q.scope === "all" && !(can(req.ctx, "other_pharmacies") || can(req.ctx, "pharmacies.all")))
            throw new HttpError(403, "You can only see your own pharmacy's patients");
        const where = ["p.active = 0"];
        const params = [];
        if (q.scope !== "all") {
            where.push("(d.location_id = ? OR d.location_id IS NULL)");
            params.push(req.ctx.locationId);
        }
        const term = (q.q ?? "").trim();
        if (term) {
            where.push("(p.name LIKE ? ESCAPE '\\' OR p.id LIKE ? ESCAPE '\\')");
            params.push(like(term), like(term));
        }
        return db().all(`${PATIENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.name LIMIT 500`, params)
            .map(patientView);
    });
    /**
     * Duplicate-ID check while typing a new patient (legacy txtPatientID_AfterUpdate).
     * Returns the minimum the legacy message showed: name, department, pharmacy, active.
     */
    app.get("/check/:id", async (req) => {
        const id = parse(zPatientId, req.params.id);
        const p = findPatient(db(), id);
        if (!p)
            return { exists: false };
        return {
            exists: true, active: !!p.active, here: p.location_id === req.ctx.locationId,
            patient: { id: p.id, name: p.name, department: p.department, departmentId: p.department_id, locationId: p.location_id, locationName: p.location_name ?? null },
        };
    });
    app.get("/:id", async (req) => {
        const p = patientInLocation(db(), req.params.id, req.ctx.locationId);
        return patientView(p);
    });
    /** Patient label data (legacy rptPatientLabel). */
    app.get("/:id/label", async (req) => {
        const p = patientInLocation(db(), req.params.id, req.ctx.locationId);
        return {
            patientId: p.id, patientName: p.name, department: p.department, coverage: p.coverage, diagnosis: p.diagnosis,
            dob: p.dob, isChild: isChildFromDob(p.dob), notes: p.notes, location: p.location_name ?? null,
        };
    });
    /** New patient. Duplicate ID → 409 with details.code = exists_inactive | exists_active so the UI can offer reactivate/transfer. */
    app.post("/", async (req) => {
        requirePerm(req, "patients");
        const b = parse(createSchema, req.body);
        const d = db();
        assertLocalDepartment(d, b.departmentId, req.ctx.locationId);
        if (b.operationId != null && !d.get("SELECT 1 FROM operations WHERE id=?", [b.operationId]))
            throw bad("Operation not found");
        const existing = findPatient(d, b.id);
        if (existing) {
            const view = patientView(existing);
            if (!existing.active)
                throw new HttpError(409, "This patient ID belongs to an inactive patient", { code: "exists_inactive", patient: view });
            throw new HttpError(409, `This patient ID belongs to an active patient${existing.location_name ? ` in ${existing.location_name}` : ""}`, { code: "exists_active", patient: view });
        }
        const now = nowIso();
        d.run(`INSERT INTO patients(id,name,coverage,department_id,status,diagnosis,dob,is_child,notes,operation_id,active,created_at,updated_at,
         sex,weight_kg,weight_at,height_cm,height_at,allergy_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`, [b.id, b.name, b.coverage, b.departmentId, b.status, b.diagnosis, b.dob, isChildFromDob(b.dob) ? 1 : 0, b.notes, b.operationId, now, now,
            b.sex, b.weightKg ?? null, b.weightKg != null ? now : null, b.heightCm ?? null, b.heightCm != null ? now : null, b.allergyStatus === "has" ? "unknown" : b.allergyStatus ?? "unknown"]);
        audit(req, "patient.create", "patient", b.id, { departmentId: b.departmentId });
        return patientView(findPatient(d, b.id));
    });
    /** Edit. Department changes stay within this pharmacy (use /transfer to receive a patient from another one). */
    app.put("/:id", async (req) => {
        requirePerm(req, "patients");
        const id = req.params.id;
        const d = db();
        const p = patientInLocation(d, id, req.ctx.locationId);
        const b = parse(updateSchema, req.body);
        if (b.departmentId != null)
            assertLocalDepartment(d, b.departmentId, req.ctx.locationId);
        if (b.operationId != null && !d.get("SELECT 1 FROM operations WHERE id=?", [b.operationId]))
            throw bad("Operation not found");
        const next = {
            name: b.name ?? p.name, coverage: b.coverage !== undefined ? b.coverage : p.coverage,
            department_id: b.departmentId ?? p.department_id, status: b.status !== undefined ? b.status : p.status,
            diagnosis: b.diagnosis !== undefined ? b.diagnosis : p.diagnosis, dob: b.dob !== undefined ? b.dob : p.dob,
            notes: b.notes !== undefined ? b.notes : p.notes, operation_id: b.operationId !== undefined ? b.operationId : p.operation_id,
            sex: b.sex !== undefined ? b.sex : p.sex ?? null,
        };
        const now = nowIso();
        // a weight or height keeps the time it was measured (entered): a changed value gets a new time
        const wt = b.weightKg !== undefined && b.weightKg !== (p.weight_kg ?? null) ? { v: b.weightKg, at: b.weightKg == null ? null : now } : { v: p.weight_kg ?? null, at: p.weight_at ?? null };
        const ht = b.heightCm !== undefined && b.heightCm !== (p.height_cm ?? null) ? { v: b.heightCm, at: b.heightCm == null ? null : now } : { v: p.height_cm ?? null, at: p.height_at ?? null };
        // "has allergies" follows the recorded allergies (allergiesChanged); here only unknown / no known allergies are chosen
        const hasActive = !!d.get("SELECT 1 FROM patient_allergies WHERE patient_id = ? AND active = 1", [id]);
        if (b.allergyStatus === "nka" && hasActive)
            throw bad("This patient has allergies recorded — remove them first to mark No known allergies");
        const allergy = b.allergyStatus && b.allergyStatus !== "has" && !hasActive ? b.allergyStatus : p.allergy_status ?? "unknown";
        d.run(`UPDATE patients SET name=?, coverage=?, department_id=?, status=?, diagnosis=?, dob=?, is_child=?, notes=?, operation_id=?, updated_at=?,
         sex=?, weight_kg=?, weight_at=?, height_cm=?, height_at=?, allergy_status=? WHERE id=?`, [next.name, next.coverage, next.department_id, next.status, next.diagnosis, next.dob, isChildFromDob(next.dob) ? 1 : 0,
            next.notes, next.operation_id, now, next.sex, wt.v, wt.at, ht.v, ht.at, allergy, id]);
        audit(req, "patient.update", "patient", id, b);
        return patientView(findPatient(d, id));
    });
    /** Soft delete (legacy cmdDelete: Activity = False). */
    app.post("/:id/deactivate", async (req) => {
        requirePerm(req, "patients");
        const id = req.params.id;
        const p = patientInLocation(db(), id, req.ctx.locationId);
        if (!p.active)
            return patientView(p);
        db().run("UPDATE patients SET active=0, updated_at=? WHERE id=?", [nowIso(), id]);
        audit(req, "patient.deactivate", "patient", id);
        return patientView(findPatient(db(), id));
    });
    /** Reactivate an inactive patient (from any pharmacy) into a department of this pharmacy chosen explicitly. */
    app.post("/:id/reactivate", async (req) => {
        requirePerm(req, "patients");
        const id = req.params.id;
        const { departmentId } = parse(deptSchema, req.body);
        const d = db();
        const p = findPatient(d, id);
        if (!p)
            throw new HttpError(404, "Patient not found");
        if (p.active)
            throw new HttpError(409, "Patient is already active");
        assertLocalDepartment(d, departmentId, req.ctx.locationId);
        d.run("UPDATE patients SET active=1, department_id=?, is_child=?, updated_at=? WHERE id=?", [departmentId, isChildFromDob(p.dob) ? 1 : 0, nowIso(), id]);
        audit(req, "patient.reactivate", "patient", id, { fromDepartmentId: p.department_id, departmentId });
        return patientView(findPatient(d, id));
    });
    /** Receive an active patient from another department/pharmacy into a department of this pharmacy. */
    app.post("/:id/transfer", async (req) => {
        requirePerm(req, "patients");
        const id = req.params.id;
        const { departmentId } = parse(deptSchema, req.body);
        const d = db();
        const p = findPatient(d, id);
        if (!p)
            throw new HttpError(404, "Patient not found");
        if (!p.active)
            throw new HttpError(409, "Patient is inactive — use Restore");
        assertLocalDepartment(d, departmentId, req.ctx.locationId);
        d.run("UPDATE patients SET department_id=?, is_child=?, updated_at=? WHERE id=?", [departmentId, isChildFromDob(p.dob) ? 1 : 0, nowIso(), id]);
        audit(req, "patient.transfer", "patient", id, { fromDepartmentId: p.department_id, fromLocationId: p.location_id, departmentId });
        return patientView(findPatient(d, id));
    });
    // ---- allergies (core/safety.ts checks every order and dispense against them)
    const zAllergy = z.object({
        kind: z.enum(["ingredient", "class", "other"], { message: "Choose what the patient is allergic to" }),
        value: z.string().trim().min(2, "Enter the medicine, ingredient or class").max(120),
        reaction: zOptStr,
        severity: z.enum(["mild", "moderate", "severe"], { message: "Choose the severity" }).default("moderate"),
    });
    const allergyList = (id) => db().all(`SELECT a.id, a.kind, a.value, a.reaction, a.severity, a.created_at AS "createdAt", u.display_name AS "createdBy"
     FROM patient_allergies a LEFT JOIN users u ON u.id = a.created_by WHERE a.patient_id = ? AND a.active = 1 ORDER BY a.id`, [id]);
    /** Keeps the patient's allergy status in step: "has" with any allergy recorded, back to unknown when the last is removed. */
    const syncStatus = (id) => {
        const has = !!db().get("SELECT 1 FROM patient_allergies WHERE patient_id = ? AND active = 1", [id]);
        db().run("UPDATE patients SET allergy_status = CASE WHEN ? THEN 'has' WHEN allergy_status = 'has' THEN 'unknown' ELSE allergy_status END, updated_at = ? WHERE id = ?", [has ? 1 : 0, nowIso(), id]);
    };
    app.get("/:id/allergies", async (req) => {
        const p = patientInLocation(db(), req.params.id, req.ctx.locationId);
        return allergyList(p.id);
    });
    app.post("/:id/allergies", async (req) => {
        requirePerm(req, "patients");
        const p = patientInLocation(db(), req.params.id, req.ctx.locationId);
        const b = parse(zAllergy, req.body);
        const id = db().tx(() => {
            if (db().get("SELECT 1 FROM patient_allergies WHERE patient_id = ? AND active = 1 AND kind = ? AND value = ? COLLATE NOCASE", [p.id, b.kind, b.value]))
                throw new HttpError(409, "This allergy is already recorded");
            const r = db().run("INSERT INTO patient_allergies(patient_id, kind, value, reaction, severity, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)", [p.id, b.kind, b.value, b.reaction, b.severity, req.ctx.userId, nowIso(), nowIso()]);
            syncStatus(p.id);
            return r.lastId;
        });
        audit(req, "patient.allergy.add", "patient", p.id, { allergyId: id, ...b });
        return allergyList(p.id);
    });
    app.delete("/:id/allergies/:allergyId", async (req) => {
        requirePerm(req, "patients");
        const p = patientInLocation(db(), req.params.id, req.ctx.locationId);
        const allergyId = Number(req.params.allergyId);
        const a = db().get("SELECT * FROM patient_allergies WHERE id = ? AND patient_id = ? AND active = 1", [allergyId, p.id]);
        if (!a)
            throw new HttpError(404, "Allergy not found");
        db().tx(() => {
            db().run("UPDATE patient_allergies SET active = 0, updated_at = ? WHERE id = ?", [nowIso(), allergyId]);
            syncStatus(p.id);
        });
        audit(req, "patient.allergy.remove", "patient", p.id, { allergyId, kind: a.kind, value: a.value });
        return allergyList(p.id);
    });
}
