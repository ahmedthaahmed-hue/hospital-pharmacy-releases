import { nowIso, toLocalDate, now as clockNow, newRunId } from "../lib/time.js";
import { round3 } from "./schedule.js";
import { bad } from "../lib/http.js";
import { currentScope } from "../platform/clock.js";
/**
 * SQL: is the batch row `b` (alias) on hold — quarantined at its pharmacy, or its lot recalled in every pharmacy
 * (batch_holds, release 1.5)? Held stock is never dispensed and does not count as usable.
 */
export const heldSql = (b) => `EXISTS (SELECT 1 FROM batch_holds h WHERE h.active = 1 AND h.item_id = ${b}.item_id
  AND h.batch_no = ${b}.batch_no COLLATE NOCASE AND (h.location_id IS NULL OR h.location_id = ${b}.location_id))`;
/**
 * While any batch of the item is held at the pharmacy, its temporary (TEMP) stock is not used either: TEMP stands for
 * packs on the shelf without a batch on record, and those may well be the held ones (a recall must not be dispensed
 * as TEMP, out of sight of its trace).
 */
export const tempBlockedSql = (b) => `(${b}.is_placeholder = 1 AND EXISTS (SELECT 1 FROM batch_holds h WHERE h.active = 1 AND h.item_id = ${b}.item_id
  AND (h.location_id IS NULL OR h.location_id = ${b}.location_id)))`;
function batchFilter(includePlaceholders, allowExpired) {
    return `item_id = ? AND location_id = ? AND qty > 0
    ${includePlaceholders ? "" : "AND is_placeholder = 0"}
    ${allowExpired ? "" : "AND (expiry_date IS NULL OR expiry_date >= ?)"}
    AND NOT ${heldSql("batches")} AND NOT ${tempBlockedSql("batches")}`;
}
/** Quantity FEFO can actually dispense (non-expired; placeholders included by default). */
/**
 * A controlled medicine (records, release 1.7) is never given from temporary (TEMP) stock: every dose must come from a
 * real batch, so that it is in the controlled register.
 */
function isControlled(db, itemId) {
    return !!db.get("SELECT controlled AS c FROM items WHERE id = ?", [itemId])?.c;
}
export function available(db, itemId, locationId, opts = {}) {
    const inc = (opts.includePlaceholders ?? true) && !isControlled(db, itemId), exp = opts.allowExpired ?? false;
    const params = [itemId, locationId];
    if (!exp)
        params.push(toLocalDate(clockNow()));
    const r = db.get(`SELECT COALESCE(SUM(qty),0) q FROM batches WHERE ${batchFilter(inc, exp)}`, params);
    return round3(r?.q ?? 0);
}
/** Stock split for display: usable / expired / placeholder / held (quarantined or recalled, not expired). */
export function stockSummary(db, itemId, locationId) {
    const today = toLocalDate(clockNow());
    const held = heldSql("batches");
    return db.get(`SELECT
       COALESCE(SUM(CASE WHEN is_placeholder=0 AND (expiry_date IS NULL OR expiry_date >= :t) AND NOT ${held} THEN qty END),0) usable,
       COALESCE(SUM(CASE WHEN expiry_date < :t THEN qty END),0) expired,
       COALESCE(SUM(CASE WHEN is_placeholder=1 AND (expiry_date IS NULL OR expiry_date >= :t) AND NOT ${held} AND NOT ${tempBlockedSql("batches")} THEN qty END),0) placeholder,
       COALESCE(SUM(CASE WHEN (expiry_date IS NULL OR expiry_date >= :t) AND ${held} THEN qty END),0) held
     FROM batches WHERE item_id = :i AND location_id = :l AND qty > 0`, { t: today, i: itemId, l: locationId });
}
/** Batch that supplied the dose starting at `offset` units into the dispense (labels show the actual batch). */
export function batchAt(lines, offset) {
    let cum = 0;
    for (const l of lines) {
        cum += l.qty;
        if (offset < cum - 1e-9)
            return l;
    }
    return lines[lines.length - 1];
}
/**
 * Which batches FEFO would take `qty` from now, without taking anything (the daily run's picking list). Same order and
 * the same rules as dispenseFEFO.
 */
export function planFEFO(db, itemId, locationId, qty) {
    const params = [itemId, locationId, toLocalDate(clockNow())];
    // a controlled medicine never comes from TEMP stock (as in dispenseFEFO / available)
    const batches = db.all(`SELECT batch_no, expiry_date, qty, is_placeholder FROM batches WHERE ${batchFilter(!isControlled(db, itemId), false)}
     ORDER BY is_placeholder ASC, IFNULL(expiry_date,'9999-12-31') ASC, id ASC`, params);
    const out = [];
    let left = round3(qty);
    for (const b of batches) {
        if (left <= 0)
            break;
        const take = round3(Math.min(b.qty, left));
        out.push({ batchNo: b.batch_no, expiry: b.expiry_date, qty: take, placeholder: !!b.is_placeholder });
        left = round3(left - take);
    }
    return out;
}
export function dispenseFEFO(db, input) {
    const runId = input.runId ?? newRunId();
    const want = round3(Number(input.qty) || 0);
    const res = { runId, requested: want, dispensed: 0, short: want, lines: [] };
    if (want <= 0 || !input.itemId)
        return res;
    const inc = (input.includePlaceholders ?? true) && !isControlled(db, input.itemId), exp = input.allowExpired ?? false;
    const scope = currentScope();
    return db.tx(() => {
        const params = [input.itemId, input.locationId];
        if (!exp)
            params.push(toLocalDate(clockNow()));
        params.push(input.preferBatch ?? "");
        const batches = db.all(`SELECT id, batch_no, expiry_date, qty, is_placeholder FROM batches WHERE ${batchFilter(inc, exp)}
       ORDER BY (batch_no = ? COLLATE NOCASE AND is_placeholder = 0) DESC, is_placeholder ASC, IFNULL(expiry_date,'9999-12-31') ASC, id ASC`, params);
        // What to take from which batch, in the order taken (one dispense row per batch).
        const takes = new Map();
        const left = new Map(batches.map((b) => [b.id, b.qty]));
        let remaining = want;
        const takeFrom = (b, max) => {
            const q = round3(Math.min(left.get(b.id) ?? 0, max, remaining));
            if (q <= 0)
                return 0;
            const t = takes.get(b.id);
            if (t)
                t.qty = round3(t.qty + q);
            else
                takes.set(b.id, { b, qty: q });
            left.set(b.id, round3((left.get(b.id) ?? 0) - q));
            remaining = round3(remaining - q);
            return q;
        };
        // Work replayed from a pharmacy PC: first the batches the PC took for this dispense (its packs left the shelf), as
        // far as they are usable here — the same rules as FEFO, so never an expired, held or (controlled) TEMP one.
        const fromPc = scope?.op && scope.pcBatches ? claimPcBatches(scope.pcBatches, input.itemId, input.patientId ?? null, want, (scope.pcUndo ??= [])) : [];
        const missed = [];
        for (const use of fromPc) {
            let got = 0;
            for (const b of batches) {
                if (got >= use.qty - 1e-9 || remaining <= 0)
                    break;
                if (sameBatch(b, use))
                    got = round3(got + takeFrom(b, round3(use.qty - got)));
            }
            if (got < use.qty - 1e-9)
                missed.push({ use, got });
        }
        // Then FEFO (the scanned batch first) for the rest.
        for (const b of batches) {
            if (remaining <= 0)
                break;
            takeFrom(b, remaining);
        }
        const now = nowIso();
        for (const { b, qty: take } of takes.values()) {
            db.run("UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?", [take, b.id]);
            const d = db.run(`INSERT INTO dispenses(at, location_id, patient_id, patient_name, order_id, walkin_ticket_id, item_id, batch_id, qty, type, user_id, run_id, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [now, input.locationId, input.patientId ?? null, input.patientName ?? null, input.orderId ?? null, input.ticketId ?? null,
                input.itemId, b.id, take, input.type, input.userId ?? null, runId, input.notes ?? null]);
            db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,?,?,?,?)", [now, b.id, "dispense", -take, d.lastId, input.userId ?? null]);
            res.lines.push({ batchId: b.id, batchNo: b.batch_no, expiry: b.expiry_date, qty: take, placeholder: !!b.is_placeholder, dispenseId: d.lastId });
        }
        res.dispensed = round3(want - remaining);
        res.short = remaining;
        // Pharmacy PC: the batches this write took, queued with it (platform/pharmacy-agent.ts), so the main server takes
        // the same ones when it replays the work.
        if (scope?.pcWrite && !scope.pcWrite.closed) {
            const list = (scope.batches ??= []);
            for (const l of res.lines)
                if (list.length < MAX_BATCH_USES)
                    list.push({ itemId: input.itemId, batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, placeholder: l.placeholder,
                        patientId: input.patientId ?? null, dispenseId: l.dispenseId, batchId: l.batchId });
        }
        // Replayed: a batch the PC gave that could not be taken here is reported with the work's answer (platform/hub.ts).
        if (missed.length && scope)
            noteBatchDiff(scope, describeMiss(db, input, inc, exp, fromPc, missed, res.lines));
        return res;
    });
}
/** Most batch lines one queued write keeps (a whole-ward run dispenses a few thousand). */
export const MAX_BATCH_USES = 20_000;
/** A batch here that is the one the PC took: its TEMP stock for TEMP; else the same batch number (any case) and expiry. */
function sameBatch(b, use) {
    if (use.placeholder)
        return b.is_placeholder === 1;
    return b.is_placeholder === 0 && b.batch_no.toUpperCase() === use.batchNo.toUpperCase() && (b.expiry_date ?? "") === (use.expiry ?? "");
}
/**
 * The PC's batch lines for one dispense being replayed: the next ones of the same item for the same patient, in the
 * order the PC took them, up to the quantity dispensed. They are used up, so when one request dispenses the same item
 * several times (a ward run, a cart) each dispense here lines up with the same one on the PC.
 */
export function claimPcBatches(queue, itemId, patientId, qty, undo) {
    const out = [];
    let want = round3(qty);
    for (let i = 0; i < queue.length && want > 0;) {
        const u = queue[i];
        if (u.itemId !== itemId || (u.patientId ?? null) !== patientId) {
            i++;
            continue;
        }
        const q = round3(Math.min(u.qty, want));
        out.push({ ...u, qty: q });
        want = round3(want - q);
        undo?.push({ index: i, use: u, qty: u.qty, removed: q >= u.qty - 1e-9 });
        if (q >= u.qty - 1e-9)
            queue.splice(i, 1);
        else {
            u.qty = round3(u.qty - q);
            i++;
        }
    }
    return out;
}
/**
 * A transaction of replayed work was rolled back (db/index.ts tx): what it took from the PC's lines goes back, in
 * reverse, so the next dispense of the same item and patient lines up with them; and its differences are not reported.
 */
export function undoPcClaims(scope, mark) {
    const q = scope.pcBatches, log = scope.pcUndo;
    if (q && log)
        while (log.length > mark.undo) {
            const e = log.pop();
            if (e.removed)
                q.splice(e.index, 0, e.use);
            else
                e.use.qty = e.qty;
        }
    if (scope.batchDiffs)
        scope.batchDiffs.length = Math.min(scope.batchDiffs.length, mark.diffs);
    scope.batchDiffMore = mark.more;
}
/** Keeps the first 11 differences in words (10 are shown, platform/outcome.ts) and counts the rest. */
export function noteBatchDiff(scope, text) {
    const list = (scope.batchDiffs ??= []);
    if (list.length < 11)
        list.push(text);
    else
        scope.batchDiffMore = (scope.batchDiffMore ?? 0) + 1;
}
/** The PC's lines no dispense here took (another patient or item here, or not dispensed at all), in words. */
export function unclaimedPcBatches(db, scope) {
    const left = new Map();
    for (const u of scope.pcBatches ?? [])
        if (u.qty > 1e-9) {
            const k = `${u.itemId}\u0000${u.patientId ?? ""}`;
            (left.get(k) ?? left.set(k, []).get(k)).push(u);
        }
    for (const us of left.values()) {
        const { itemId, patientId } = us[0];
        const name = db.get("SELECT name FROM items WHERE id = ?", [itemId])?.name;
        noteBatchDiff(scope, `${name ? `${name} (${itemId})` : itemId}${patientId ? `, patient ${patientId}` : ""}: `
            + `the PC gave ${batchList(us)}, which no dispensing here took`);
    }
    if (scope.pcBatches)
        scope.pcBatches.length = 0;
}
const batchName = (u) => (u.placeholder ? "temporary stock (TEMP)" : `batch ${u.batchNo}`);
const batchList = (xs) => xs.length ? xs.map((x) => `${batchName(x)} ×${round3(x.qty)}`).join(", ") : "nothing";
/** In words: the batches the PC gave, the ones recorded here, and why the PC's could not be used here. */
function describeMiss(db, input, inc, exp, fromPc, missed, lines) {
    const name = db.get("SELECT name FROM items WHERE id = ?", [input.itemId])?.name;
    const why = missed.map(({ use, got }) => `${batchName(use)}: ${missReason(db, input, inc, exp, use, got)}`).join("; ");
    return `${name ? `${name} (${input.itemId})` : input.itemId}${input.patientId ? `, patient ${input.patientId}` : ""}: `
        + `the PC gave ${batchList(fromPc)}; recorded here from ${batchList(lines)} (${why})`;
}
function missReason(db, input, inc, exp, use, got) {
    if (use.placeholder && !inc)
        return "a controlled medicine is never given from temporary stock";
    const rows = db.all(`SELECT qty, expiry_date, (${heldSql("batches")} OR ${tempBlockedSql("batches")}) AS held FROM batches WHERE item_id = ? AND location_id = ?
     AND ${use.placeholder ? "is_placeholder = 1" : "is_placeholder = 0 AND batch_no = ? COLLATE NOCASE AND IFNULL(expiry_date,'') = IFNULL(?,'')"}`, use.placeholder ? [input.itemId, input.locationId] : [input.itemId, input.locationId, use.batchNo, use.expiry]);
    if (rows.some((r) => r.held && r.qty > 0))
        return "on hold here (quarantined or recalled), so not dispensed";
    const today = toLocalDate(clockNow());
    if (!exp && rows.some((r) => r.qty > 0 && r.expiry_date != null && r.expiry_date < today))
        return "expired here, so not dispensed";
    return got > 0 ? `only ${got} of it here` : "none of it in stock here";
}
/** Find a batch by its full key or create it with qty 0 (legacy FindOrCreateBatch). */
export function findOrCreateBatch(db, itemId, locationId, batchNo, expiry) {
    const b = db.get("SELECT id FROM batches WHERE item_id=? AND location_id=? AND batch_no=? AND IFNULL(expiry_date,'')=IFNULL(?,'')", [itemId, locationId, batchNo, expiry]);
    if (b)
        return b.id;
    return db.run("INSERT INTO batches(item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,0,0,?)", [itemId, locationId, batchNo, expiry, nowIso()]).lastId;
}
/** The batch number of temporary (TEMP) stock (stock/service.ts PLACEHOLDER). */
export const TEMP_BATCH_NO = "XXX666";
/**
 * The batch a return goes into. Never a temporary (TEMP) one, whatever the letter case of its number; the same number
 * in another letter case is the batch on record. With no expiry given, a batch number already on record with an expiry
 * is that batch (a new batch that never expires is not made beside it), and a new batch needs its expiry unless the
 * item has none in any batch.
 */
export function returnBatch(db, itemId, locationId, batchNo, expiry) {
    const no = batchNo.trim();
    if (!no)
        throw bad("Enter the batch no.");
    if (no.toUpperCase() === TEMP_BATCH_NO
        || db.get("SELECT 1 FROM batches WHERE item_id = ? AND batch_no = ? COLLATE NOCASE AND is_placeholder = 1 LIMIT 1", [itemId, no]))
        throw bad("Cannot return to a temporary batch (TEMP) — enter the real batch no.");
    // real batches of this number (any letter case), this pharmacy's first and the exact spelling first
    const known = db.all(`SELECT batch_no, expiry_date, location_id FROM batches WHERE item_id = ? AND batch_no = ? COLLATE NOCASE AND is_placeholder = 0
     ORDER BY location_id = ? DESC, batch_no = ? DESC, id`, [itemId, no, locationId, no]);
    const here = known.filter((b) => b.location_id === locationId);
    if (expiry)
        return { batchNo: (here.find((b) => b.expiry_date === expiry) ?? known.find((b) => b.expiry_date === expiry))?.batch_no ?? no, expiry };
    const undated = here.find((b) => b.expiry_date == null);
    if (undated)
        return { batchNo: undated.batch_no, expiry: null };
    const expiries = (rows) => [...new Set(rows.map((b) => b.expiry_date).filter((e) => e != null))];
    const dated = expiries(here).length ? expiries(here) : expiries(known);
    if (dated.length === 1) {
        const b = here.find((x) => x.expiry_date === dated[0]) ?? known.find((x) => x.expiry_date === dated[0]);
        return { batchNo: b.batch_no, expiry: dated[0] };
    }
    if (dated.length > 1)
        throw bad(`Batch ${no} is on record with more than one expiry date — choose the expiry date`);
    if (db.get("SELECT 1 FROM batches WHERE item_id = ? AND is_placeholder = 0 AND expiry_date IS NOT NULL LIMIT 1", [itemId]))
        throw bad("Enter the expiry date of the returned pack");
    return { batchNo: no, expiry: null };
}
export function returnToStock(db, r) {
    const qty = round3(Number(r.qty) || 0);
    if (qty <= 0)
        throw new Error("Return quantity must be greater than zero");
    return db.tx(() => {
        const into = returnBatch(db, r.itemId, r.locationId, r.batchNo, r.expiry || null);
        const batchId = findOrCreateBatch(db, r.itemId, r.locationId, into.batchNo, into.expiry);
        const now = nowIso();
        db.run("UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?", [qty, batchId]);
        const d = db.run(`INSERT INTO dispenses(at, location_id, patient_id, patient_name, item_id, batch_id, qty, type, user_id, run_id, notes)
       VALUES (?,?,?,?,?,?,?,'return',?,?,?)`, [now, r.locationId, r.patientId ?? null, r.patientName ?? null, r.itemId, batchId, qty, r.userId ?? null, newRunId(),
            r.notes ?? `Return: Batch ${into.batchNo} Exp ${into.expiry ?? "?"}`]);
        db.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,dispense_id,user_id) VALUES (?,?,?,?,?,?)", [now, batchId, "return", qty, d.lastId, r.userId ?? null]);
        return { batchId, dispenseId: d.lastId, qty, batchNo: into.batchNo, expiry: into.expiry };
    });
}
/** Most recent batch dispensed to this patient for this item at this location (return prefill). */
export function lastDispensedBatch(db, patientId, itemId, locationId) {
    return db.get(`SELECT b.id batch_id, b.batch_no, b.expiry_date FROM dispenses d JOIN batches b ON b.id = d.batch_id
     WHERE d.patient_id = ? AND d.item_id = ? AND d.location_id = ? AND d.type <> 'return'
     ORDER BY d.at DESC, d.id DESC LIMIT 1`, [patientId, itemId, locationId]);
}
