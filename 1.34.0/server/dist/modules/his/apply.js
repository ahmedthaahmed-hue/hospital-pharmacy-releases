// The hospital system link (release 1.14): what happens to each message from the hospital's system (parse.ts).
//
//   Admissions, transfers and discharges apply at once: the patient is added (or brought back, or moved) to the
//   department the hospital system names — its code mapped once to a department here (his_maps), else matched by
//   name — and a discharge makes the patient inactive. One that cannot apply (a department not known yet, a new patient
//   without a name) waits with its reason and is tried again after the mapping is made.
//
//   Doctors' orders never become orders by themselves: each waits in the inbox (Clinical → Hospital orders) for a
//   pharmacist, who accepts it (POST /api/orders with hisMessageId: a real order, with every safety check and
//   confirmation) or rejects it with a reason. A cancellation from the hospital system withdraws a waiting order, or —
//   when the order was already accepted — waits for a pharmacist to stop it.
//
// Files come from the inbox folder (setting his.inbox_folder, read every his.poll_seconds; each file read is moved to
// processed/ or, if it could not be read, failed/) or are uploaded on the Hospital system page. Dispensing goes back the
// other way for billing and insurance: a CSV file in his.export_folder every his.export_minutes (export.ts).
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { db } from "../../db/index.js";
import { normalizeGtin } from "../../core/gs1.js";
import { settingNum, settingStr } from "../../core/settings.js";
import { featureOn } from "../../core/feature-gate.js";
import { nowIso } from "../../lib/time.js";
import { findPatient, isChildFromDob } from "../patients/scope.js";
import { audit } from "../../lib/http.js";
import { parseFile } from "./parse.js";
const formatOf = (name, text) => {
    const n = name.toLowerCase(), t = text.replace(/^﻿/, "").trimStart();
    return n.endsWith(".hl7") || t.startsWith("MSH|") ? "hl7" : n.endsWith(".json") || t.startsWith("{") ? "fhir" : "csv";
};
/** The department a hospital-system code or name stands for here (mapped, else the same name), or null. */
export function departmentFor(d, code) {
    if (!code)
        return null;
    const m = d.get("SELECT target FROM his_maps WHERE kind = 'department' AND code = ?", [code]);
    if (m)
        return Number(m.target);
    return d.get("SELECT id FROM departments WHERE active = 1 AND location_id IS NOT NULL AND name = ? COLLATE NOCASE", [code])?.id ?? null;
}
/** The item a hospital-system drug code stands for (mapped, the same item code, a barcode, or the same name), or null. */
export function itemFor(d, drug, name) {
    const m = d.get("SELECT target FROM his_maps WHERE kind = 'item' AND code = ?", [drug]);
    if (m && d.get("SELECT 1 FROM items WHERE id = ?", [m.target]))
        return m.target;
    if (d.get("SELECT 1 FROM items WHERE id = ?", [drug]))
        return drug;
    const gtin = normalizeGtin(drug);
    const bc = d.get("SELECT item_id FROM item_barcodes WHERE code = ? OR code = ?", [gtin ?? drug, drug]);
    if (bc)
        return bc.item_id;
    for (const n of [name, drug]) {
        if (!n)
            continue;
        const it = d.all("SELECT id FROM items WHERE (name = ? COLLATE NOCASE OR selection_name = ? COLLATE NOCASE) LIMIT 2", [n, n]);
        if (it.length === 1)
            return it[0].id; // one item only: a name shared by several is not a match
    }
    return null;
}
const ORDER_KEYS = ["drug", "dose", "qtyPerDose", "frequencyHours", "once", "route", "startDate", "firstDoseTime", "durationDays", "notes"];
const sameOrder = (a, b) => ORDER_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
/** Applies an admission, transfer or discharge. Returns why it could not, or null when done. */
function applyPatient(d, m) {
    const now = nowIso();
    const p = findPatient(d, m.patientId);
    if (m.kind === "discharge") {
        if (p?.active) {
            d.run("UPDATE patients SET active = 0, updated_at = ? WHERE id = ?", [now, m.patientId]);
            audit(null, "his.discharge", "patient", m.patientId);
        }
        return null;
    }
    // what is known of the patient now (an update, or with an admission): measurements dated only when they change
    const details = (q) => {
        d.run(`UPDATE patients SET name = COALESCE(?, name), dob = COALESCE(?, dob), is_child = ?, sex = COALESCE(?, sex),
        weight_at = CASE WHEN ? IS NULL OR weight_kg IS ? THEN weight_at ELSE ? END, weight_kg = COALESCE(?, weight_kg),
        height_at = CASE WHEN ? IS NULL OR height_cm IS ? THEN height_at ELSE ? END, height_cm = COALESCE(?, height_cm), updated_at = ? WHERE id = ?`, [m.name ?? null, m.dob ?? null, isChildFromDob(m.dob ?? q.dob) ? 1 : 0, m.sex ?? null,
            m.weightKg ?? null, m.weightKg ?? null, now, m.weightKg ?? null, m.heightCm ?? null, m.heightCm ?? null, now, m.heightCm ?? null, now, m.patientId]);
    };
    if (m.kind === "update") {
        // never admits, moves or brings back a discharged patient: only the details
        if (!p)
            return "The patient is not known here";
        details(p);
        audit(null, "his.update", "patient", m.patientId);
        return null;
    }
    const dept = departmentFor(d, m.department);
    if (m.department && dept == null)
        return `The department "${m.department}" is not known here: map it on the Hospital system page`;
    if (!p) {
        if (!m.name)
            return "A new patient needs a name";
        if (dept == null)
            return "A new patient needs a department";
        d.run(`INSERT INTO patients(id,name,department_id,dob,is_child,active,created_at,updated_at,sex,weight_kg,weight_at,height_cm,height_at,allergy_status)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,'unknown')`, [m.patientId, m.name, dept, m.dob ?? null, isChildFromDob(m.dob ?? null) ? 1 : 0, now, now, m.sex ?? null,
            m.weightKg ?? null, m.weightKg != null ? now : null, m.heightCm ?? null, m.heightCm != null ? now : null]);
        audit(null, "his.admit", "patient", m.patientId, { departmentId: dept });
        return null;
    }
    // known patient: back (if discharged) or moved to the department, with what the hospital system knows now
    d.run("UPDATE patients SET active = 1, department_id = COALESCE(?, department_id), updated_at = ? WHERE id = ?", [dept, now, m.patientId]);
    details(p);
    audit(null, m.kind === "transfer" ? "his.transfer" : "his.admit", "patient", m.patientId, { departmentId: dept, wasActive: !!p.active });
    return null;
}
/** Stores and handles one message read from the hospital system. */
function handle(d, source, format, p) {
    const now = nowIso();
    if ("error" in p) {
        d.run("INSERT INTO his_messages(received_at,source,format,kind,status,data,error) VALUES (?,?,?,'unreadable','error',?,?)", [now, source, format, JSON.stringify({ raw: p.raw }), p.error]);
        return { status: "error" };
    }
    if ("ignore" in p)
        return { status: "skipped" };
    const m = p.msg;
    const insert = (status, extra = {}) => d.run(`INSERT INTO his_messages(received_at,source,format,kind,patient_id,ref,status,data,item_id,order_id,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [now, source, format, m.kind, m.patientId, m.ref ?? null, status, JSON.stringify(m), extra.item_id ?? null, extra.order_id ?? null, extra.error ?? null]);
    if (m.kind === "order") {
        // the same order sent again: kept once; sent again with other details, it is a change the pharmacist sees
        const prev = m.ref ? d.get("SELECT * FROM his_messages WHERE kind = 'order' AND ref = ? AND patient_id = ? AND status IN ('pending','accepted','rejected') ORDER BY id DESC", [m.ref, m.patientId]) : undefined;
        if (prev) {
            if (sameOrder(JSON.parse(prev.data), m)) {
                insert("skipped", { error: "Already received" });
                return { status: "skipped" };
            }
            if (prev.status === "pending") {
                // not accepted yet: the new details replace the waiting ones
                d.run("UPDATE his_messages SET status = 'cancelled', decided_at = ?, note = 'Changed by the hospital system' WHERE id = ?", [now, prev.id]);
            }
            else if (prev.status === "accepted") {
                // accepted: the pharmacist changes the order on Ward dispensing (or stops it), then marks this done — once per
                // change: the same change sent again is kept once, and a newer one replaces one not dealt with yet
                const waiting = d.get("SELECT * FROM his_messages WHERE kind = 'change' AND ref = ? AND patient_id = ? AND status = 'pending' ORDER BY id DESC", [m.ref ?? null, m.patientId]);
                if (waiting && sameOrder(JSON.parse(waiting.data), m)) {
                    insert("skipped", { error: "Already received" });
                    return { status: "skipped" };
                }
                if (waiting)
                    d.run("UPDATE his_messages SET status = 'cancelled', decided_at = ?, note = 'Changed again by the hospital system' WHERE id = ?", [now, waiting.id]);
                d.run(`INSERT INTO his_messages(received_at,source,format,kind,patient_id,ref,status,data,item_id,order_id) VALUES (?,?,?,'change',?,?,'pending',?,?,?)`, [now, source, format, m.patientId, m.ref ?? null, JSON.stringify(m), itemFor(d, m.drug, m.drugName), prev.order_id]);
                return { status: "pending" };
            }
        }
        const item = itemFor(d, m.drug, m.drugName);
        insert("pending", { item_id: item, error: findPatient(d, m.patientId) ? null : "The patient is not admitted here yet" });
        return { status: "pending" };
    }
    if (m.kind === "cancel") {
        const o = d.get("SELECT * FROM his_messages WHERE kind = 'order' AND ref = ? AND patient_id = ? AND status IN ('pending','accepted') ORDER BY id DESC", [m.ref, m.patientId]);
        if (!o) {
            insert("error", { error: "No order with this number was received" });
            return { status: "error" };
        }
        if (o.status === "pending") {
            d.run("UPDATE his_messages SET status = 'cancelled', decided_at = ?, note = 'Cancelled by the hospital system' WHERE id = ?", [now, o.id]);
            insert("applied", { order_id: null });
            return { status: "applied" };
        }
        // accepted already: a pharmacist stops the order (it may have been dispensed; the run must not just lose it)
        insert("pending", { order_id: o.order_id });
        return { status: "pending" };
    }
    const why = applyPatient(d, m);
    insert(why ? "error" : "applied", { error: why });
    return { status: why ? "error" : "applied" };
}
/** Reads a file's messages (from the inbox folder or uploaded) and handles each. */
export function importText(source, text) {
    const d = db();
    const format = formatOf(source, text);
    const parsed = parseFile(source, text);
    const out = { read: parsed.length, applied: 0, pending: 0, errors: 0, skipped: 0 };
    d.tx(() => {
        for (const p of parsed) {
            const { status } = handle(d, source, format, p);
            if (status === "applied")
                out.applied++;
            else if (status === "pending")
                out.pending++;
            else if (status === "skipped")
                out.skipped++;
            else
                out.errors++;
        }
    });
    return out;
}
/** Tries the patient messages that waited (a department since mapped) again. Returns how many applied now. */
export function retryWaiting() {
    const d = db();
    let n = 0;
    d.tx(() => {
        for (const r of d.all("SELECT * FROM his_messages WHERE status = 'error' AND kind IN ('admit','transfer','discharge','update') ORDER BY id")) {
            // a newer message about the same patient has applied since: this one is out of date (a discharge came after it)
            if (d.get("SELECT 1 FROM his_messages WHERE patient_id = ? AND id > ? AND status = 'applied' AND kind IN ('admit','transfer','discharge','update')", [r.patient_id, r.id])) {
                d.run("UPDATE his_messages SET status = 'skipped', error = 'Superseded by a later message' WHERE id = ?", [r.id]);
                continue;
            }
            const why = applyPatient(d, JSON.parse(r.data));
            d.run("UPDATE his_messages SET status = ?, error = ? WHERE id = ?", [why ? "error" : "applied", why, r.id]);
            if (!why)
                n++;
        }
        // orders whose patient has arrived since, and whose drug code has been mapped since
        for (const r of d.all("SELECT * FROM his_messages WHERE status = 'pending' AND kind = 'order'")) {
            const m = JSON.parse(r.data);
            d.run("UPDATE his_messages SET item_id = COALESCE(item_id, ?), error = ? WHERE id = ?", [itemFor(d, m.drug, m.drugName), findPatient(d, m.patientId) ? null : "The patient is not admitted here yet", r.id]);
        }
    });
    return n;
}
/**
 * A pharmacist accepted an order (orders/routes.ts, in the same transaction as the new order). Work replayed from a
 * pharmacy PC may have accepted, offline, an order the hospital system cancelled or changed meanwhile: the order is kept
 * (doses may have been given against it) and a pharmacist is asked to stop it.
 */
export function markAccepted(d, messageId, orderId, patientId, userId, replay = false) {
    const now = nowIso();
    const r = d.run(`UPDATE his_messages SET status = 'accepted', order_id = ?, decided_by = ?, decided_at = ?, error = NULL
    WHERE id = ? AND kind = 'order' AND status = 'pending' AND patient_id = ?`, [orderId, userId, now, messageId, patientId]);
    if (r.changes > 0)
        return true;
    if (!replay)
        return false;
    const m = d.get("SELECT * FROM his_messages WHERE id = ? AND kind = 'order' AND status = 'cancelled' AND patient_id = ?", [messageId, patientId]);
    if (!m)
        return false;
    d.run("UPDATE his_messages SET status = 'accepted', order_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", [orderId, userId, now, m.id]);
    d.run(`INSERT INTO his_messages(received_at,source,format,kind,patient_id,ref,status,data,order_id,note) VALUES (?,'pharmacy PC','csv','cancel',?,?,'pending',?,?,?)`, [now, patientId, m.ref, JSON.stringify({ kind: "cancel", ref: m.ref, patientId }), orderId, "Accepted offline after the hospital system had cancelled or changed it"]);
    return true;
}
/* ---------------- the inbox folder ---------------- */
let lastPoll = null;
export const lastInboxPoll = () => lastPoll;
const READABLE = new Set([".csv", ".txt", ".hl7", ".json"]);
/**
 * Reads every new file waiting in the inbox folder (main server, with the link on and a folder set). Asynchronous: a
 * shared folder that does not answer must not hold up the whole server. A file is read once by its content (his_files),
 * then moved to processed\ — or failed\ when it could not be read — and, when the share does not allow moving it, it is
 * left where it is and not read again.
 */
export async function pollInbox() {
    const dir = settingStr("his.inbox_folder").trim();
    if (!featureOn("his_link") || !dir)
        return 0;
    let files = 0;
    try {
        const names = (await readdir(dir)).sort();
        for (const name of names) {
            if (!READABLE.has(extname(name).toLowerCase()))
                continue;
            const path = join(dir, name);
            const st = await stat(path).catch(() => null);
            // a file still being written (changed in the last few seconds) is read next time
            if (!st?.isFile() || Date.now() - st.mtimeMs < 3000)
                continue;
            const stamp = nowIso().replace(/[-:T]/g, "").slice(0, 14);
            const move = async (to) => { try {
                await mkdir(join(dir, to), { recursive: true });
                await rename(path, join(dir, to, `${stamp}-${basename(name)}`));
            }
            catch { /* read-only share: left, known by its content */ } };
            if (st.size > 20 * 1024 * 1024) {
                logUnreadable(name, "The file is over 20 MB");
                await move("failed");
                files++;
                continue;
            }
            let text;
            try {
                text = await readFile(path, "utf8");
            }
            catch (e) {
                logUnreadable(name, String(e?.message ?? e));
                continue;
            }
            const hash = createHash("sha256").update(text).digest("hex");
            const known = !!db().get("SELECT 1 FROM his_files WHERE hash = ?", [hash]);
            if (!known) {
                try {
                    db().tx(() => { db().run("INSERT INTO his_files(hash, name, read_at) VALUES (?,?,?)", [hash, name, nowIso()]); importText(name, text); });
                }
                catch (e) {
                    logUnreadable(name, String(e?.message ?? e));
                    await move("failed");
                    files++;
                    continue;
                }
                files++;
            }
            await move("processed");
        }
        lastPoll = { at: nowIso(), files };
    }
    catch (e) {
        lastPoll = { at: nowIso(), files, error: e?.code === "ENOENT" ? `The inbox folder ${dir} cannot be found` : String(e?.message ?? e) };
    }
    return files;
}
function logUnreadable(name, error) {
    db().run("INSERT INTO his_messages(received_at,source,format,kind,status,data,error) VALUES (?,?,?,'unreadable','error','{}',?)", [nowIso(), name, "csv", error]);
}
export const pollSeconds = () => Math.max(15, settingNum("his.poll_seconds") || 60);
