import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, notFound, parse, requirePerm, zBool, zId } from "../../lib/http.js";
import { ITEM_NAME, isBlank, itemDefaults, zItemId, zQty, zText } from "../walkin/shared.js";
const zName = z.string().trim().min(1, "Enter the template name").max(200);
function loadTemplate(d, id, locationId) {
    const t = d.get("SELECT id, name, location_id AS locationId, active FROM rx_templates WHERE id = ?", [id]);
    if (!t || t.locationId !== locationId)
        throw notFound("Template");
    return { ...t, active: !!t.active };
}
function templateLines(d, id) {
    return d.all(`SELECT l.id, l.line_no AS lineNo, l.item_id AS itemId, ${ITEM_NAME} AS itemName, i.unit AS itemUnit, l.qty, l.notes, l.route, l.conc, l.unit
     FROM rx_template_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.template_id = ? ORDER BY l.line_no, l.id`, [id]);
}
function fullTemplate(d, id, locationId) {
    return { ...loadTemplate(d, id, locationId), lines: templateLines(d, id) };
}
function resequence(d, templateId) {
    d.all("SELECT id, line_no FROM rx_template_lines WHERE template_id = ? ORDER BY line_no, id", [templateId])
        .forEach((r, i) => { if (r.line_no !== i + 1)
        d.run("UPDATE rx_template_lines SET line_no = ? WHERE id = ?", [i + 1, r.id]); });
}
const nextLineNo = (d, templateId) => (d.get("SELECT MAX(line_no) m FROM rx_template_lines WHERE template_id = ?", [templateId])?.m ?? 0) + 1;
/** Copy all lines of a template (every field) into another template. */
export function copyRxLines(d, fromId, toId) {
    const lines = d.all("SELECT item_id, qty, notes, route, conc, unit FROM rx_template_lines WHERE template_id = ? ORDER BY line_no, id", [fromId]);
    let no = nextLineNo(d, toId);
    for (const l of lines)
        d.run("INSERT INTO rx_template_lines(template_id, line_no, item_id, qty, notes, route, conc, unit) VALUES (?,?,?,?,?,?,?,?)", [toId, no++, l.item_id, l.qty, l.notes, l.route, l.conc, l.unit]);
    return lines.length;
}
const zLine = {
    qty: zQty.optional(),
    notes: zText(1000).optional(),
    route: zText(100).optional(),
    conc: zText(100).optional(),
    unit: zText(100).optional(),
};
export default async function routes(app) {
    const loc = (req) => req.ctx.locationId;
    /** Templates of the current pharmacy: active first, then by name (legacy RefreshTemplateList). */
    app.get("/", async (req) => {
        return db().all(`SELECT t.id, t.name, t.active, (SELECT COUNT(*) FROM rx_template_lines l WHERE l.template_id = t.id) AS lineCount
       FROM rx_templates t WHERE t.location_id = ? ORDER BY t.active DESC, t.name COLLATE NOCASE`, [loc(req)]).map((t) => ({ ...t, active: !!t.active }));
    });
    app.post("/", async (req) => {
        requirePerm(req, "templates");
        const b = parse(z.object({ name: zName }), req.body);
        const d = db();
        const id = d.run("INSERT INTO rx_templates(name, location_id, active) VALUES (?,?,1)", [b.name, loc(req)]).lastId;
        audit(req, "rx_template.create", "rx_template", id, b);
        return fullTemplate(d, id, loc(req));
    });
    app.get("/:id", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        return fullTemplate(db(), id, loc(req));
    });
    /** Rename and/or activate / deactivate. */
    app.patch("/:id", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ name: zName.optional(), active: zBool.optional() }), req.body);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        d.run("UPDATE rx_templates SET name = ?, active = ? WHERE id = ?", [b.name ?? t.name, b.active ?? (t.active ? 1 : 0), id]);
        audit(req, "rx_template.update", "rx_template", id, b);
        return fullTemplate(d, id, loc(req));
    });
    app.delete("/:id", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        d.tx(() => {
            d.run("DELETE FROM rx_template_lines WHERE template_id = ?", [id]);
            d.run("DELETE FROM rx_templates WHERE id = ?", [id]);
        });
        audit(req, "rx_template.delete", "rx_template", id, { name: t.name });
        return { ok: true };
    });
    /** Duplicate as "<name> (Copy)" (legacy frmRxTemplates wording) in the current pharmacy, copying every line field. */
    app.post("/:id/duplicate", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTemplate(d, id, loc(req));
        const newId = d.tx(() => {
            const nid = d.run("INSERT INTO rx_templates(name, location_id, active) VALUES (?,?,1)", [`${t.name} (Copy)`, loc(req)]).lastId;
            copyRxLines(d, id, nid);
            return nid;
        });
        audit(req, "rx_template.duplicate", "rx_template", newId, { from: id });
        return fullTemplate(d, newId, loc(req));
    });
    /** Copy a walk-in ticket's lines into this template: replace (delete existing lines first) or append. */
    app.post("/:id/from-ticket", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ ticketId: zId, mode: z.enum(["replace", "append"]) }), req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        const ticket = d.get("SELECT id, location_id FROM walkin_tickets WHERE id = ?", [b.ticketId]);
        if (!ticket || ticket.location_id !== loc(req))
            throw notFound("Ticket");
        const copied = d.tx(() => {
            const lines = d.all("SELECT item_id, qty, notes, route, conc, unit FROM walkin_lines WHERE ticket_id = ? AND item_id IS NOT NULL AND qty > 0 ORDER BY line_no, id", [b.ticketId]);
            if (!lines.length)
                throw bad("The ticket has no items");
            if (b.mode === "replace")
                d.run("DELETE FROM rx_template_lines WHERE template_id = ?", [id]);
            let no = nextLineNo(d, id);
            for (const l of lines)
                d.run("INSERT INTO rx_template_lines(template_id, line_no, item_id, qty, notes, route, conc, unit) VALUES (?,?,?,?,?,?,?,?)", [id, no++, l.item_id, l.qty, l.notes, l.route, l.conc, l.unit]);
            return lines.length;
        });
        audit(req, "rx_template.from_ticket", "rx_template", id, { ...b, copied });
        return { ...fullTemplate(d, id, loc(req)), copied };
    });
    /** Add a line: qty defaults to 1, unit from the item, route / concentration from item defaults when empty. */
    app.post("/:id/lines", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId, ...zLine }), req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        const def = itemDefaults(d, b.itemId);
        const lineId = d.run("INSERT INTO rx_template_lines(template_id, line_no, item_id, qty, notes, route, conc, unit) VALUES (?,?,?,?,?,?,?,?)", [id, nextLineNo(d, id), def.id, b.qty ?? 1, b.notes ?? null, b.route ?? def.route, b.conc ?? def.conc, b.unit ?? def.unit]).lastId;
        audit(req, "rx_template.line_add", "rx_template_line", lineId, { templateId: id, itemId: b.itemId });
        return fullTemplate(d, id, loc(req));
    });
    app.patch("/:id/lines/:lineId", async (req) => {
        requirePerm(req, "templates");
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId.optional(), ...zLine }), req.body);
        const d = db();
        loadTemplate(d, id, loc(req));
        const l = d.get("SELECT * FROM rx_template_lines WHERE id = ? AND template_id = ?", [lineId, id]);
        if (!l)
            throw notFound("Line");
        const n = {
            item_id: b.itemId ?? l.item_id, qty: b.qty ?? l.qty, notes: b.notes !== undefined ? b.notes : l.notes,
            route: b.route !== undefined ? b.route : l.route, conc: b.conc !== undefined ? b.conc : l.conc, unit: b.unit !== undefined ? b.unit : l.unit,
        };
        if (b.itemId && b.itemId !== l.item_id) {
            // legacy cboItem_AfterUpdate: unit always follows the item; route / conc only when empty
            const def = itemDefaults(d, b.itemId);
            if (b.unit === undefined)
                n.unit = def.unit;
            if (isBlank(n.route))
                n.route = def.route;
            if (isBlank(n.conc))
                n.conc = def.conc;
        }
        d.run("UPDATE rx_template_lines SET item_id=?, qty=?, notes=?, route=?, conc=?, unit=? WHERE id=?", [n.item_id, n.qty, n.notes, n.route, n.conc, n.unit, lineId]);
        audit(req, "rx_template.line_update", "rx_template_line", lineId, b);
        return fullTemplate(d, id, loc(req));
    });
    app.delete("/:id/lines/:lineId", async (req) => {
        requirePerm(req, "templates");
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const d = db();
        loadTemplate(d, id, loc(req));
        const r = d.tx(() => {
            const r = d.run("DELETE FROM rx_template_lines WHERE id = ? AND template_id = ?", [lineId, id]);
            resequence(d, id);
            return r;
        });
        if (!r.changes)
            throw notFound("Line");
        audit(req, "rx_template.line_delete", "rx_template_line", lineId, { templateId: id });
        return fullTemplate(d, id, loc(req));
    });
}
