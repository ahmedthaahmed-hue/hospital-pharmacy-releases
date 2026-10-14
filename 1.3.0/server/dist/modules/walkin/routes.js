import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, HttpError, notFound, parse, requirePerm, zBool, zId } from "../../lib/http.js";
import { now as clockNow, nowIso, toLocalDate, toLocalIso, newRunId } from "../../lib/time.js";
import { available, dispenseFEFO } from "../../core/fefo.js";
import { medicalDay, round3 } from "../../core/schedule.js";
import { ITEM_NAME, isBlank, itemDefaults, zItemId, zQty, zText } from "./shared.js";
import { nextBatch } from "../../core/labels.js";
import { isChildFromDob } from "../patients/scope.js";
import { scheduleSettings } from "../orders/view.js";
const TICKET_SELECT = `
  SELECT t.id, t.created_at AS createdAt, t.location_id AS locationId, t.patient_ref AS patientRef, t.patient_name AS patientName,
         t.dispensed_at AS dispensedAt, u.display_name AS createdBy,
         (SELECT COUNT(*) FROM walkin_lines l WHERE l.ticket_id = t.id) AS lineCount,
         (SELECT COUNT(*) FROM walkin_lines l WHERE l.ticket_id = t.id AND l.dispensed_qty > 0) AS dispensedLines,
         (SELECT COUNT(*) FROM walkin_lines l WHERE l.ticket_id = t.id AND l.to_dispense = 1 AND l.item_id IS NOT NULL
             AND l.qty > l.dispensed_qty + 0.0005) AS pendingLines
  FROM walkin_tickets t LEFT JOIN users u ON u.id = t.user_id`;
function withStatus(t) {
    if (!t)
        return t;
    const status = t.lineCount === 0 ? "empty" : t.dispensedLines === 0 ? "open" : t.pendingLines > 0 ? "partial" : "dispensed";
    return { ...t, status };
}
function loadTicket(d, id, locationId) {
    const t = d.get(`${TICKET_SELECT} WHERE t.id = ?`, [id]);
    if (!t || t.locationId !== locationId)
        throw notFound("Ticket");
    return withStatus(t);
}
function ticketLines(d, ticketId, locationId) {
    const rows = d.all(`SELECT l.id, l.line_no AS lineNo, l.item_id AS itemId, ${ITEM_NAME} AS itemName, i.unit AS itemUnit,
            l.route, l.conc, l.unit, l.qty, l.notes, l.to_dispense AS toDispense, l.to_print AS toPrint, l.dispensed_qty AS dispensedQty
     FROM walkin_lines l LEFT JOIN items i ON i.id = l.item_id
     WHERE l.ticket_id = ? ORDER BY l.line_no, l.id`, [ticketId]);
    const avail = new Map();
    return rows.map((r) => {
        if (r.itemId && !avail.has(r.itemId))
            avail.set(r.itemId, available(d, r.itemId, locationId));
        return {
            ...r, toDispense: !!r.toDispense, toPrint: !!r.toPrint,
            remaining: round3(Math.max(0, r.qty - r.dispensedQty)),
            available: r.itemId ? avail.get(r.itemId) : null,
        };
    });
}
function fullTicket(d, id, locationId) {
    return { ...loadTicket(d, id, locationId), lines: ticketLines(d, id, locationId) };
}
function resequence(d, ticketId) {
    const rows = d.all("SELECT id, line_no FROM walkin_lines WHERE ticket_id = ? ORDER BY line_no, id", [ticketId]);
    rows.forEach((r, i) => { if (r.line_no !== i + 1)
        d.run("UPDATE walkin_lines SET line_no = ? WHERE id = ?", [i + 1, r.id]); });
}
function nextLineNo(d, ticketId) {
    return (d.get("SELECT MAX(line_no) m FROM walkin_lines WHERE ticket_id = ?", [ticketId])?.m ?? 0) + 1;
}
/** Append the lines of an Rx template to a ticket (legacy ApplyTemplateToTicket). Blank route/conc/unit get the item defaults. */
function appendTemplate(d, ticketId, templateId, locationId) {
    const tpl = d.get("SELECT id, name, location_id, active FROM rx_templates WHERE id = ?", [templateId]);
    if (!tpl || tpl.location_id !== locationId)
        throw notFound("Template");
    if (!tpl.active)
        throw bad("This template is inactive");
    const lines = d.all("SELECT item_id, qty, notes, route, conc, unit FROM rx_template_lines WHERE template_id = ? ORDER BY line_no, id", [templateId]);
    if (!lines.length)
        throw bad("The template has no items");
    let no = nextLineNo(d, ticketId);
    const now = nowIso();
    for (const l of lines) {
        const def = itemDefaults(d, l.item_id);
        d.run(`INSERT INTO walkin_lines(ticket_id, line_no, item_id, route, conc, unit, qty, notes, to_dispense, to_print, dispensed_qty, created_at)
       VALUES (?,?,?,?,?,?,?,?,1,1,0,?)`, [ticketId, no++, l.item_id, isBlank(l.route) ? def.route : l.route, isBlank(l.conc) ? def.conc : l.conc,
            isBlank(l.unit) ? def.unit : l.unit, l.qty > 0 ? l.qty : 1, l.notes ?? null, now]);
    }
    return lines.length;
}
const zHeader = z.object({ patientRef: zText(40), patientName: zText(200) });
const zLineFields = {
    qty: zQty.optional(),
    route: zText(100).optional(),
    conc: zText(100).optional(),
    unit: zText(100).optional(),
    notes: zText(1000).optional(),
    toDispense: zBool.optional(),
    toPrint: zBool.optional(),
};
function requirePatient(t) {
    if (isBlank(t.patientRef) || isBlank(t.patientName))
        throw bad("Enter the patient ID and name first");
}
/**
 * Dispense the outstanding quantity of every to-dispense line. Without allowPartial nothing is dispensed when any line is
 * short: the plan comes back with needsConfirm so the user decides (legacy capped silently).
 */
export function dispenseTicket(d, req) {
    return d.tx(() => {
        const t = loadTicket(d, req.ticketId, req.locationId);
        requirePatient(t);
        const lines = d.all(`SELECT l.id, l.line_no, l.item_id, ${ITEM_NAME} AS item_name, l.qty, l.dispensed_qty
       FROM walkin_lines l JOIN items i ON i.id = l.item_id
       WHERE l.ticket_id = ? AND l.to_dispense = 1 AND l.qty > 0 ORDER BY l.line_no, l.id`, [t.id]);
        if (!lines.length)
            throw bad("No lines selected to dispense on this ticket");
        // Plan: what each line still needs vs. what FEFO can give (items repeated on several lines share the stock).
        const left = new Map();
        const plan = lines.map((l) => {
            const requested = round3(Math.max(0, l.qty - l.dispensed_qty));
            if (!left.has(l.item_id))
                left.set(l.item_id, available(d, l.item_id, req.locationId));
            const avail = left.get(l.item_id);
            if (requested <= 0)
                return { lineId: l.id, lineNo: l.line_no, itemId: l.item_id, itemName: l.item_name, requested: 0, available: avail, dispensed: 0, short: 0, status: "already" };
            const can = round3(Math.min(requested, avail));
            left.set(l.item_id, round3(avail - can));
            return { lineId: l.id, lineNo: l.line_no, itemId: l.item_id, itemName: l.item_name, requested, available: avail, dispensed: can, short: round3(requested - can), status: "pending" };
        });
        const todo = plan.filter((p) => p.status === "pending");
        if (!todo.length)
            return { ok: true, nothingToDo: true, runId: null, lines: plan, dispensedLines: 0, shortLines: 0 };
        if (todo.some((p) => p.short > 0) && !req.allowPartial) {
            return { ok: false, needsConfirm: true, lines: plan, runId: null, dispensedLines: 0, shortLines: todo.filter((p) => p.short > 0).length };
        }
        const runId = newRunId();
        for (const p of todo) {
            const want = p.dispensed;
            p.dispensed = 0;
            if (want > 0) {
                const r = dispenseFEFO(d, {
                    locationId: req.locationId, itemId: p.itemId, qty: want, type: "walkin", patientId: t.patientRef, patientName: t.patientName,
                    ticketId: t.id, userId: req.userId, runId, notes: `Ticket ${t.id}`,
                });
                p.dispensed = r.dispensed;
                p.batches = r.lines.map((b) => ({ batchNo: b.batchNo, expiry: b.expiry, qty: b.qty, placeholder: b.placeholder }));
                if (r.dispensed > 0)
                    d.run("UPDATE walkin_lines SET dispensed_qty = ROUND(dispensed_qty + ?, 3) WHERE id = ?", [r.dispensed, p.lineId]);
            }
            p.short = round3(p.requested - p.dispensed);
            p.status = p.short <= 0 ? "dispensed" : p.dispensed > 0 ? "partial" : "out_of_stock";
        }
        const dispensedLines = todo.filter((p) => p.dispensed > 0).length;
        if (dispensedLines)
            d.run("UPDATE walkin_tickets SET dispensed_at = ? WHERE id = ?", [nowIso(), t.id]);
        return { ok: true, nothingToDo: false, runId, lines: plan, dispensedLines, shortLines: todo.filter((p) => p.short > 0).length };
    });
}
function labelsFor(d, t, locationId) {
    const date = toLocalDate(clockNow());
    // The legacy label marks children (DLookup on Patients by the ticket's patient number).
    const pat = t.patientRef ? d.get("SELECT dob FROM patients WHERE id = ?", [t.patientRef]) : undefined;
    const isChild = pat ? isChildFromDob(pat.dob) : false;
    // A dispensed line's label names the batch that was handed out (the first, FEFO, batch of the item's latest dispense on
    // this ticket); the next FEFO batch may already be another one when the dispense emptied a batch.
    const dispensedBatch = (itemId) => d.get(`SELECT b.batch_no, b.expiry_date, b.is_placeholder FROM dispenses x JOIN batches b ON b.id = x.batch_id
     WHERE x.walkin_ticket_id = ? AND x.item_id = ? AND x.type = 'walkin'
       AND x.run_id = (SELECT y.run_id FROM dispenses y WHERE y.walkin_ticket_id = ? AND y.item_id = ? AND y.type = 'walkin'
                       ORDER BY y.at DESC, y.id DESC LIMIT 1)
     ORDER BY x.id LIMIT 1`, [t.id, itemId, t.id, itemId]);
    return d.all(`SELECT l.id AS lineId, ${ITEM_NAME} AS itemName, l.qty, COALESCE(l.unit, i.unit) AS unit, l.route, l.conc, l.notes,
            i.id AS itemId, i.name AS itemFullName, i.unit AS itemUnit, i.active_ingredient AS ac, i.strength AS itemConc,
            i.special, i.use_window AS useWindow, l.dispensed_qty AS dispensedQty
     FROM walkin_lines l JOIN items i ON i.id = l.item_id WHERE l.ticket_id = ? AND l.to_print = 1 ORDER BY l.line_no, l.id`, [t.id]).map(({ dispensedQty, ...l }) => {
        const nb = (dispensedQty > 0 ? dispensedBatch(l.itemId) : undefined) ?? nextBatch(d, l.itemId, locationId);
        return { ticketId: t.id, patientRef: t.patientRef, patientName: t.patientName, ...l, date, isChild,
            batchNo: nb?.batch_no ?? null, batchExpiry: nb?.expiry_date ?? null, isPlaceholderBatch: !!nb?.is_placeholder };
    });
}
export default async function routes(app) {
    const loc = (req) => req.ctx.locationId;
    /** Recent tickets of this pharmacy (current medical day), or a search by patient ref / name / ticket no. across all dates. */
    app.get("/tickets", async (req) => {
        const q = parse(z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
        const d = db();
        if (q.q) {
            const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; // % and _ typed by the user are literal
            return d.all(`${TICKET_SELECT} WHERE t.location_id = ? AND (t.patient_ref LIKE ? ESCAPE '\\' OR t.patient_name LIKE ? ESCAPE '\\' OR CAST(t.id AS TEXT) = ?)
         ORDER BY t.created_at DESC, t.id DESC LIMIT ?`, [loc(req), like, like, q.q, q.limit ?? 50]).map(withStatus);
        }
        const day = medicalDay(clockNow(), scheduleSettings(d).dayStart);
        const from = toLocalIso(day.start);
        return d.all(`${TICKET_SELECT} WHERE t.location_id = ? AND t.created_at > ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`, [loc(req), from, q.limit ?? 100]).map(withStatus);
    });
    /** Start a ticket (optionally with the patient header and an Rx template applied in the same transaction). */
    app.post("/tickets", async (req) => {
        requirePerm(req, "walkin");
        const b = parse(zHeader.extend({ templateId: zId.optional() }), req.body ?? {});
        const d = db();
        const id = d.tx(() => {
            const id = d.run("INSERT INTO walkin_tickets(created_at, location_id, patient_ref, patient_name, user_id) VALUES (?,?,?,?,?)", [nowIso(), loc(req), b.patientRef ?? null, b.patientName ?? null, req.ctx.userId]).lastId;
            if (b.templateId)
                appendTemplate(d, id, b.templateId, loc(req));
            return id;
        });
        audit(req, "walkin.create", "walkin_ticket", id, b.templateId ? { templateId: b.templateId } : undefined);
        return fullTicket(d, id, loc(req));
    });
    app.get("/tickets/:id", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        return fullTicket(db(), id, loc(req));
    });
    app.patch("/tickets/:id", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(zHeader.partial(), req.body);
        const d = db();
        const t = loadTicket(d, id, loc(req));
        const ref = b.patientRef !== undefined ? b.patientRef : t.patientRef;
        const name = b.patientName !== undefined ? b.patientName : t.patientName;
        if (t.dispensedLines > 0 && (ref !== t.patientRef || name !== t.patientName))
            throw new HttpError(409, "Cannot change the patient after dispensing from the ticket — start a new ticket");
        d.run("UPDATE walkin_tickets SET patient_ref = ?, patient_name = ? WHERE id = ?", [ref ?? null, name ?? null, id]);
        audit(req, "walkin.update", "walkin_ticket", id, b);
        return fullTicket(d, id, loc(req));
    });
    /** Delete a ticket that has dispensed nothing (e.g. started by mistake). */
    app.delete("/tickets/:id", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTicket(d, id, loc(req));
        if (t.dispensedLines > 0 || d.get("SELECT 1 FROM dispenses WHERE walkin_ticket_id = ? LIMIT 1", [id]))
            throw new HttpError(409, "Cannot delete a ticket that has been dispensed from");
        d.tx(() => {
            d.run("DELETE FROM walkin_lines WHERE ticket_id = ?", [id]);
            d.run("DELETE FROM walkin_tickets WHERE id = ?", [id]);
        });
        audit(req, "walkin.delete", "walkin_ticket", id);
        return { ok: true };
    });
    /** Add a line. Choosing the item fills only empty unit / route / concentration (legacy cboItemID_AfterUpdate). */
    app.post("/tickets/:id/lines", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId, ...zLineFields }), req.body);
        const d = db();
        loadTicket(d, id, loc(req));
        const def = itemDefaults(d, b.itemId);
        const lineId = d.tx(() => d.run(`INSERT INTO walkin_lines(ticket_id, line_no, item_id, route, conc, unit, qty, notes, to_dispense, to_print, dispensed_qty, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`, [id, nextLineNo(d, id), def.id, b.route ?? def.route, b.conc ?? def.conc, b.unit ?? def.unit, b.qty ?? 1, b.notes ?? null,
            b.toDispense ?? 1, b.toPrint ?? 1, nowIso()]).lastId);
        audit(req, "walkin.line_add", "walkin_line", lineId, { ticketId: id, itemId: b.itemId });
        return fullTicket(d, id, loc(req));
    });
    app.patch("/tickets/:id/lines/:lineId", async (req) => {
        requirePerm(req, "walkin");
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const b = parse(z.object({ itemId: zItemId.optional(), ...zLineFields }), req.body);
        const d = db();
        loadTicket(d, id, loc(req));
        const l = d.get("SELECT * FROM walkin_lines WHERE id = ? AND ticket_id = ?", [lineId, id]);
        if (!l)
            throw notFound("Line");
        const next = {
            item_id: b.itemId ?? l.item_id, qty: b.qty ?? l.qty,
            route: b.route !== undefined ? b.route : l.route, conc: b.conc !== undefined ? b.conc : l.conc,
            unit: b.unit !== undefined ? b.unit : l.unit, notes: b.notes !== undefined ? b.notes : l.notes,
            to_dispense: b.toDispense ?? l.to_dispense, to_print: b.toPrint ?? l.to_print,
        };
        if (b.itemId && b.itemId !== l.item_id) {
            if (l.dispensed_qty > 0)
                throw new HttpError(409, "Cannot change an item that has been dispensed — add a new line");
            const def = itemDefaults(d, b.itemId);
            if (isBlank(next.unit))
                next.unit = def.unit;
            if (isBlank(next.route))
                next.route = def.route;
            if (isBlank(next.conc))
                next.conc = def.conc;
        }
        if (next.qty < l.dispensed_qty - 0.0005)
            throw bad(`Quantity is less than already dispensed (${round3(l.dispensed_qty)})`);
        d.run(`UPDATE walkin_lines SET item_id=?, qty=?, route=?, conc=?, unit=?, notes=?, to_dispense=?, to_print=? WHERE id=?`, [next.item_id, next.qty, next.route, next.conc, next.unit, next.notes, next.to_dispense, next.to_print, lineId]);
        audit(req, "walkin.line_update", "walkin_line", lineId, b);
        return fullTicket(d, id, loc(req));
    });
    /** Delete a line, then renumber 1..n (legacy ResequenceTicketLines). Dispensed lines stay: return the stock instead. */
    app.delete("/tickets/:id/lines/:lineId", async (req) => {
        requirePerm(req, "walkin");
        const { id, lineId } = parse(z.object({ id: zId, lineId: zId }), req.params);
        const d = db();
        loadTicket(d, id, loc(req));
        const l = d.get("SELECT id, dispensed_qty FROM walkin_lines WHERE id = ? AND ticket_id = ?", [lineId, id]);
        if (!l)
            throw notFound("Line");
        if (l.dispensed_qty > 0)
            throw new HttpError(409, "Cannot delete a line that has been dispensed — record a return from the Stock screen");
        d.tx(() => { d.run("DELETE FROM walkin_lines WHERE id = ?", [lineId]); resequence(d, id); });
        audit(req, "walkin.line_delete", "walkin_line", lineId, { ticketId: id });
        return fullTicket(d, id, loc(req));
    });
    /** Remove every line that has not been dispensed (legacy ClearTicketLines deleted everything). */
    app.post("/tickets/:id/clear", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        loadTicket(d, id, loc(req));
        const removed = d.tx(() => {
            const r = d.run("DELETE FROM walkin_lines WHERE ticket_id = ? AND dispensed_qty = 0", [id]);
            resequence(d, id);
            return r.changes;
        });
        audit(req, "walkin.clear", "walkin_ticket", id, { removed });
        return { ...fullTicket(d, id, loc(req)), removed };
    });
    app.post("/tickets/:id/apply-template", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const { templateId } = parse(z.object({ templateId: zId }), req.body);
        const d = db();
        loadTicket(d, id, loc(req));
        const added = d.tx(() => appendTemplate(d, id, templateId, loc(req)));
        audit(req, "walkin.apply_template", "walkin_ticket", id, { templateId, added });
        return { ...fullTicket(d, id, loc(req)), added };
    });
    /** Dispense outstanding quantities. 200 + needsConfirm (nothing dispensed) when a line is short and allowPartial is false. */
    app.post("/tickets/:id/dispense", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({ allowPartial: z.boolean().optional() }), req.body ?? {});
        const d = db();
        const r = dispenseTicket(d, { ticketId: id, locationId: loc(req), userId: req.ctx.userId, allowPartial: !!b.allowPartial });
        if (r.ok && !r.nothingToDo)
            audit(req, "walkin.dispense", "walkin_ticket", id, {
                runId: r.runId, lines: r.lines.filter((l) => l.status !== "already").map((l) => ({ lineId: l.lineId, itemId: l.itemId, dispensed: l.dispensed, short: l.short })),
            });
        return { ...r, ticket: fullTicket(d, id, loc(req)) };
    });
    /** Label data (web/src/print/labels.tsx WalkInLabelData) for lines marked to print. */
    app.post("/tickets/:id/print", async (req) => {
        requirePerm(req, "walkin");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db();
        const t = loadTicket(d, id, loc(req));
        requirePatient(t);
        const labels = labelsFor(d, t, loc(req));
        if (!labels.length)
            throw bad("No lines selected to print");
        audit(req, "walkin.print", "walkin_ticket", id, { labels: labels.length });
        return labels;
    });
    /** Save the ticket's lines as a new Rx template of this pharmacy (copies item, qty, notes, route, conc, unit). */
    app.post("/tickets/:id/save-as-template", async (req) => {
        requirePerm(req, "templates");
        const { id } = parse(z.object({ id: zId }), req.params);
        const { name } = parse(z.object({ name: z.string().trim().min(1, "Enter the template name").max(200) }), req.body);
        const d = db();
        loadTicket(d, id, loc(req));
        const out = d.tx(() => {
            const lines = d.all("SELECT item_id, qty, notes, route, conc, unit FROM walkin_lines WHERE ticket_id = ? AND item_id IS NOT NULL AND qty > 0 ORDER BY line_no, id", [id]);
            if (!lines.length)
                throw bad("No valid lines to save in the template");
            const tid = d.run("INSERT INTO rx_templates(name, location_id, active) VALUES (?,?,1)", [name, loc(req)]).lastId;
            lines.forEach((l, i) => d.run("INSERT INTO rx_template_lines(template_id, line_no, item_id, qty, notes, route, conc, unit) VALUES (?,?,?,?,?,?,?,?)", [tid, i + 1, l.item_id, l.qty, l.notes, l.route, l.conc, l.unit]));
            return { id: tid, name, lineCount: lines.length };
        });
        audit(req, "walkin.save_as_template", "rx_template", out.id, { ticketId: id });
        return out;
    });
}
