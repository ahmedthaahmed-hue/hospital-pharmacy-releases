// Dispensing for the hospital system's billing and insurance (release 1.14): every dispensing line and return, with
// the patient, item, quantity, batch and (where the hospital keeps prices) its value, as a CSV file the hospital system
// reads. Written to the export folder (his.export_folder) every his.export_minutes — each file has the lines since the
// last one, so nothing is sent twice and nothing is missed (lines that arrive late from a pharmacy PC go in the next
// file) — or downloaded for any dates from the Hospital system page.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../db/index.js";
import { featureOn } from "../../core/feature-gate.js";
import { settingNum, settingStr } from "../../core/settings.js";
import { nowIso } from "../../lib/time.js";
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]);
const COLUMNS = ["dispense_id", "at", "pharmacy", "patient_id", "patient_name", "department", "item_code", "item_name", "unit", "qty", "type",
    "batch_no", "expiry", "unit_price", "amount", "order_id", "his_order_ref", "user"];
const SELECT = `
  SELECT x.id AS dispense_id, x.at, l.name AS pharmacy, x.patient_id, x.patient_name, dep.name AS department, x.item_id AS item_code,
    i.name AS item_name, i.unit,
    -- a return is written as a negative quantity (and amount), so a sum of the file is what the patient kept
    CASE WHEN x.type = 'return' THEN -x.qty ELSE x.qty END AS qty, x.type, b.batch_no, b.expiry_date AS expiry, i.unit_price,
    x.order_id, (SELECT h.ref FROM his_messages h WHERE h.order_id = x.order_id AND h.kind = 'order' AND h.status = 'accepted' LIMIT 1) AS his_order_ref,
    u.username AS user
  FROM dispenses x
  JOIN items i ON i.id = x.item_id
  LEFT JOIN locations l ON l.id = x.location_id
  LEFT JOIN batches b ON b.id = x.batch_id
  LEFT JOIN patients p ON p.id = x.patient_id
  LEFT JOIN departments dep ON dep.id = p.department_id
  LEFT JOIN users u ON u.id = x.user_id`;
const cell = (v) => {
    if (v == null)
        return "";
    let s = String(v);
    // a cell a spreadsheet would run as a formula is written as text
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))
        s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows) {
    const prices = featureOn("prices");
    const lines = [COLUMNS.join(",")];
    for (const r of rows) {
        const price = prices && r.unit_price != null ? Number(r.unit_price) : null;
        const row = { ...r, unit_price: price, amount: price != null ? Math.round(price * r.qty * 100) / 100 : null };
        lines.push(COLUMNS.map((c) => cell(row[c])).join(","));
    }
    return "﻿" + lines.join("\r\n") + "\r\n"; // with a BOM: Excel opens Arabic names correctly
}
/** Dispensing between two dates (inclusive), as CSV: one pharmacy's (locationId), or every pharmacy's (null). */
export function dispensingCsv(from, to, locationId = null) {
    const rows = db().all(`${SELECT} WHERE x.at >= ? AND x.at < date(?, '+1 day') ${locationId == null ? "" : "AND x.location_id = ?"} ORDER BY x.at, x.id`, locationId == null ? [from, to] : [from, to, locationId]);
    return { csv: toCsv(rows), rows: rows.length };
}
let lastExport = null;
export const lastDispensingExport = () => lastExport;
/** Writes the lines since the last file to the export folder (main server, with the link on and a folder set). */
export function exportDispensing(force = false) {
    const dir = settingStr("his.export_folder").trim();
    if (!featureOn("his_link") || !dir)
        return null;
    const minutes = settingNum("his.export_minutes");
    const last = META("his_export_at");
    if (!force && (!(minutes > 0) || (last && Date.now() - new Date(last).getTime() < minutes * 60_000)))
        return null;
    try {
        const after = Number(META("his_export_last_id") ?? 0);
        const rows = db().all(`${SELECT} WHERE x.id > ? ORDER BY x.id LIMIT 200000`, [after]);
        SET("his_export_at", new Date().toISOString());
        if (!rows.length) {
            lastExport = { at: nowIso(), rows: 0 };
            return { rows: 0 };
        }
        mkdirSync(dir, { recursive: true });
        const file = `dispensing-${nowIso().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}-${rows[0].dispense_id}.csv`;
        writeFileSync(join(dir, file), toCsv(rows));
        SET("his_export_last_id", String(rows[rows.length - 1].dispense_id));
        lastExport = { at: nowIso(), file, rows: rows.length };
        return { file, rows: rows.length };
    }
    catch (e) {
        lastExport = { at: nowIso(), rows: 0, error: String(e?.message ?? e) };
        return null;
    }
}
