import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, can, HttpError, notFound, parse, requirePerm } from "../../lib/http.js";
import { now as clockNow, toLocalDate, nowIso } from "../../lib/time.js";
import { nextBatch } from "../../core/labels.js";
import { patientInLocation } from "../patients/scope.js";
/** Item numbers ≥ this are reserved by the legacy importer for renumbered/missing items; the live sequence stays below. */
export const IMPORT_RESERVED_NO = 800000;
const ITEM_COLS = `i.id, i.item_no AS "itemNo", i.name, i.selection_name AS "selectionName", i.active_ingredient AS "activeIngredient",
  i.strength, i.strength_unit AS "strengthUnit", i.form, i.class, i.type, i.unit, i.special,
  i.default_dose AS "defaultDose", i.default_frequency AS "defaultFrequency", i.default_route AS "defaultRoute",
  i.default_notes AS "defaultNotes", i.use_window AS "useWindow", i.custody_page AS "custodyPage", i.active`;
const optText = (max = 200) => z.string().trim().max(max, `Text is longer than ${max} characters`).nullish().transform((v) => (v ? v : null));
const optNum = (n) => z.preprocess((v) => (v === "" || v == null ? null : v), n.nullable()).optional().transform((v) => v ?? null);
const ItemBody = z.object({
    name: z.string({ error: "Enter the item name" }).trim().min(1, "Enter the item name").max(200, "Item name is too long"),
    selectionName: optText(),
    activeIngredient: optText(),
    strength: optText(60),
    strengthUnit: optText(40),
    form: optText(80),
    class: optText(80),
    type: optText(80),
    unit: optText(60),
    special: optText(300),
    defaultDose: optText(60),
    defaultFrequency: optNum(z.coerce.number({ error: "Frequency must be a number" }).positive("Frequency must be a positive number of hours").max(24 * 30, "Frequency is too large")),
    defaultRoute: optText(60),
    defaultNotes: optText(500),
    useWindow: optText(200),
    custodyPage: optNum(z.coerce.number({ error: "Custody page must be a number" }).int("Custody page must be a whole number").min(0, "Invalid page number")),
});
const pad5 = (n) => String(n).padStart(5, "0");
/** Next free item number and ID ('A' + 5 digits). Must run inside the insert transaction. */
export function allocateItemNo() {
    const d = db();
    const max = d.get("SELECT MAX(item_no) m FROM items WHERE item_no < ?", [IMPORT_RESERVED_NO])?.m ?? 0;
    let n = Math.floor(Number(max)) + 1;
    // Legacy IDs do not always match their number; skip any number whose ID or number is already taken.
    while (d.get("SELECT 1 FROM items WHERE id = ? OR item_no = ?", [`A${pad5(n)}`, n]))
        n++;
    return { itemNo: n, id: `A${pad5(n)}` };
}
function getItem(id) {
    return db().get(`SELECT ${ITEM_COLS} FROM items i WHERE i.id = ?`, [id]);
}
/** Things that reference an item (blocks hard delete). */
function references(id) {
    const d = db();
    const c = (sql) => Number(d.get(sql, [id, id])?.c ?? 0);
    const one = (sql) => Number(d.get(sql, [id])?.c ?? 0);
    return {
        batches: one("SELECT COUNT(*) c FROM batches WHERE item_id=?"),
        dispenses: one("SELECT COUNT(*) c FROM dispenses WHERE item_id=?"),
        orders: c("SELECT COUNT(*) c FROM medication_orders WHERE item_id=? OR sec_item_id=?"),
        templates: c("SELECT (SELECT COUNT(*) FROM order_template_lines WHERE item_id=?1 OR sec_item_id=?1) + (SELECT COUNT(*) FROM rx_template_lines WHERE item_id=?2) c"),
        kits: c("SELECT (SELECT COUNT(*) FROM operation_kit_lines WHERE item_id=?1) + (SELECT COUNT(*) FROM operation_kit_exclusions WHERE item_id=?2) c"),
        walkin: one("SELECT COUNT(*) c FROM walkin_lines WHERE item_id=?"),
    };
}
function toRow(b) {
    return [b.name, b.selectionName, b.activeIngredient, b.strength, b.strengthUnit, b.form, b.class, b.type, b.unit, b.special,
        b.defaultDose, b.defaultFrequency, b.defaultRoute, b.defaultNotes, b.useWindow, b.custodyPage];
}
function assertNoDuplicate(b, exceptId) {
    const dup = db().get(`SELECT id FROM items WHERE active=1 AND TRIM(name)=? COLLATE NOCASE AND IFNULL(strength,'')=IFNULL(?,'') AND IFNULL(form,'')=IFNULL(?,'') AND id<>?`, [b.name, b.strength, b.form, exceptId ?? ""]);
    if (dup)
        throw new HttpError(409, `An active item with the same name, strength and form exists (${dup.id})`);
}
const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
export default async function routes(app) {
    /** Paginated, searchable catalogue. Response: { rows, total, page, pageSize }. */
    app.get("/", async (req) => {
        const q = parse(z.object({
            q: z.string().trim().max(100).optional().default(""),
            class: z.string().optional(), form: z.string().optional(), type: z.string().optional(), unit: z.string().optional(),
            status: z.enum(["active", "inactive", "all"]).optional().default("active"),
            page: z.coerce.number().int().min(1).optional().default(1),
            pageSize: z.coerce.number().int().min(1).max(500).optional().default(50),
            sort: z.enum(["name", "code"]).optional().default("name"),
        }), req.query);
        const where = [];
        const params = [];
        if (q.status !== "all") {
            where.push("i.active = ?");
            params.push(q.status === "active" ? 1 : 0);
        }
        for (const k of ["class", "form", "type", "unit"]) {
            const v = q[k];
            if (v === undefined || v === "")
                continue;
            if (v === "__none")
                where.push(`(i.${k} IS NULL OR TRIM(i.${k}) IN ('','-'))`);
            else {
                where.push(`TRIM(i.${k}) = ?`);
                params.push(v.trim());
            }
        }
        if (q.q) {
            const l = like(q.q);
            where.push(`(i.name LIKE ? ESCAPE '\\' OR i.selection_name LIKE ? ESCAPE '\\' OR i.active_ingredient LIKE ? ESCAPE '\\' OR i.id LIKE ? ESCAPE '\\' OR CAST(i.item_no AS TEXT) = ?)`);
            params.push(l, l, l, l, q.q);
        }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = Number(db().get(`SELECT COUNT(*) c FROM items i ${w}`, params)?.c ?? 0);
        const today = toLocalDate(clockNow());
        const order = q.sort === "code" ? "i.item_no" :
            q.q ? "CASE WHEN i.id = ? COLLATE NOCASE THEN 0 WHEN i.name LIKE ? ESCAPE '\\' OR i.selection_name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, i.name" : "CASE WHEN i.name = i.id THEN 1 ELSE 0 END, i.name"; // unnamed legacy rows last
        const orderParams = q.sort !== "code" && q.q ? [q.q, `${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, `${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`] : [];
        const rows = db().all(`SELECT ${ITEM_COLS},
         (SELECT COALESCE(SUM(b.qty),0) FROM batches b WHERE b.item_id=i.id AND b.location_id=? AND b.qty>0 AND b.is_placeholder=0
            AND (b.expiry_date IS NULL OR b.expiry_date >= ?)) AS usable,
         (SELECT COUNT(*) FROM batches b WHERE b.item_id=i.id AND b.location_id=? AND b.qty>0 AND b.is_placeholder=1) AS "hasPlaceholder"
       FROM items i ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [req.ctx.locationId, today, req.ctx.locationId, ...params, ...orderParams, q.pageSize, (q.page - 1) * q.pageSize]);
        return { rows, total, page: q.page, pageSize: q.pageSize };
    });
    /** Distinct values (with counts) for the class/form/type/unit dropdowns. */
    app.get("/facets", async () => {
        const d = db();
        const f = (col) => d.all(`SELECT TRIM(${col}) AS value, COUNT(*) AS count FROM items WHERE ${col} IS NOT NULL AND TRIM(${col}) NOT IN ('','-')
       GROUP BY TRIM(${col}) ORDER BY count DESC, value`);
        return {
            classes: f("class"), forms: f("form"), types: f("type"), units: f("unit"), strengthUnits: f("strength_unit"),
            routes: f("default_route"), specials: f("special"), useWindows: f("use_window"),
        };
    });
    /** Preview of the number the next new item will get (the real number is allocated on save). */
    app.get("/next-number", async () => allocateItemNo());
    app.get("/:id", async (req) => {
        const item = getItem(req.params.id);
        if (!item)
            throw notFound("Item");
        const today = toLocalDate(clockNow());
        const stockByLocation = !(can(req.ctx, "other_pharmacies") || can(req.ctx, "pharmacies.all")) ? [] : db().all(`SELECT l.id AS "locationId", l.name,
         COALESCE(SUM(CASE WHEN b.is_placeholder=0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?) THEN b.qty END),0) usable,
         COALESCE(SUM(CASE WHEN b.is_placeholder=0 AND b.expiry_date < ? THEN b.qty END),0) expired,
         COALESCE(SUM(CASE WHEN b.is_placeholder=1 THEN b.qty END),0) placeholder
       FROM locations l LEFT JOIN batches b ON b.location_id=l.id AND b.item_id=? AND b.qty>0
       WHERE l.active=1 GROUP BY l.id ORDER BY l.id`, [today, today, item.id]);
        const refs = references(item.id);
        const nb = nextBatch(db(), item.id, req.ctx.locationId);
        return {
            ...item, references: refs, deletable: Object.values(refs).every((v) => v === 0), stockByLocation,
            nextBatch: nb ? { batchNo: nb.batch_no, expiry: nb.expiry_date, placeholder: !!nb.is_placeholder } : null,
        };
    });
    app.post("/", async (req) => {
        requirePerm(req, "items");
        const b = parse(ItemBody, req.body);
        const created = db().tx(() => {
            assertNoDuplicate(b);
            const { itemNo, id } = allocateItemNo();
            db().run(`INSERT INTO items(id,item_no,name,selection_name,active_ingredient,strength,strength_unit,form,class,type,unit,special,
          default_dose,default_frequency,default_route,default_notes,use_window,custody_page,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, [id, itemNo, ...toRow(b)]);
            audit(req, "items.create", "item", id, { itemNo, name: b.name });
            return id;
        });
        return getItem(created);
    });
    app.put("/:id", async (req) => {
        requirePerm(req, "items");
        const b = parse(ItemBody, req.body);
        const before = getItem(req.params.id);
        if (!before)
            throw notFound("Item");
        db().tx(() => {
            if (before.active)
                assertNoDuplicate(b, before.id);
            db().run(`UPDATE items SET name=?,selection_name=?,active_ingredient=?,strength=?,strength_unit=?,form=?,class=?,type=?,unit=?,special=?,
          default_dose=?,default_frequency=?,default_route=?,default_notes=?,use_window=?,custody_page=? WHERE id=?`, [...toRow(b), before.id]);
            const after = getItem(before.id);
            const changed = Object.fromEntries(Object.keys(b).filter((k) => before[k] !== after[k]).map((k) => [k, [before[k], after[k]]]));
            audit(req, "items.update", "item", before.id, changed);
        });
        return getItem(before.id);
    });
    const setActive = (active) => async (req) => {
        requirePerm(req, "items");
        const it = getItem(req.params.id);
        if (!it)
            throw notFound("Item");
        if (it.active === active)
            return it;
        if (active) {
            const b = { name: it.name, strength: it.strength, form: it.form };
            assertNoDuplicate(b, it.id);
        }
        db().run("UPDATE items SET active=? WHERE id=?", [active, it.id]);
        audit(req, active ? "items.activate" : "items.deactivate", "item", it.id);
        return getItem(it.id);
    };
    app.post("/:id/deactivate", setActive(0));
    app.post("/:id/activate", setActive(1));
    /** Hard delete only for an item nothing refers to (e.g. created by mistake). */
    app.delete("/:id", async (req) => {
        requirePerm(req, "items");
        const it = getItem(req.params.id);
        if (!it)
            throw notFound("Item");
        const refs = references(it.id);
        if (!Object.values(refs).every((v) => v === 0))
            throw new HttpError(409, "Cannot delete an item with stock, orders or past dispensing — deactivate it instead", refs);
        db().run("DELETE FROM items WHERE id=?", [it.id]);
        audit(req, "items.delete", "item", it.id, { name: it.name, itemNo: it.itemNo });
        return { ok: true };
    });
    /** Data for the item/shelf card (legacy rptItemsCards). */
    app.get("/:id/card", async (req) => {
        const it = getItem(req.params.id);
        if (!it)
            throw notFound("Item");
        const nb = nextBatch(db(), it.id, req.ctx.locationId);
        return { itemId: it.id, itemName: it.selectionName || it.name, unit: it.unit, special: it.special, activeIngredient: it.activeIngredient,
            strengthUnit: [it.strength, it.strengthUnit].filter(Boolean).join(" ") || null,
            itemFullName: it.name, conc: it.strength ?? null, concUnit: it.strengthUnit ?? null,
            batchNo: nb?.batch_no ?? null, batchExpiry: nb?.expiry_date ?? null };
    });
    /** Opening ("use within") label: next FEFO batch at the session pharmacy; optional patient (legacy rptOpeningLabel[noname]). */
    app.get("/:id/opening-label", async (req) => {
        const it = getItem(req.params.id);
        if (!it)
            throw notFound("Item");
        const nb = nextBatch(db(), it.id, req.ctx.locationId);
        let patient;
        const pid = String(req.query.patientId ?? "").trim();
        if (pid) {
            patient = patientInLocation(db(), pid, req.ctx.locationId); // only patients of this pharmacy
        }
        return {
            itemName: it.selectionName || it.name, itemId: it.id, unit: it.unit, useWindow: it.useWindow,
            batchNo: nb?.batch_no ?? null, batchExpiry: nb?.expiry_date ?? null, isPlaceholderBatch: !!nb?.is_placeholder,
            patientName: patient?.name ?? null, patientId: patient?.id ?? null, openedAt: nowIso(),
            itemFullName: it.name, ac: it.activeIngredient ?? null, conc: it.strength ?? null, concUnit: it.strengthUnit ?? null,
            special: it.special ?? null, department: patient?.department ?? null,
        };
    });
}
