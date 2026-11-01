// Import legacy data into the application database.
//   Real data (on the hospital PC, never committed):
//     ACCDB_PASSWORD=... npm run import:legacy -- --accdb "C:\path\DataBE.accdb" --db data/pharmacy.sqlite
//   Demo data (synthetic patients + real reference data, safe for development):
//     npm run import:legacy -- --mirror ../db/pharmacy_demo.sqlite --db data/pharmacy.sqlite
// The target DB is wiped of clinical data first (users and settings are kept).
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./index.js";
import { nowIso, toLocalIso, toHHMM, parseLocal } from "../lib/time.js";
import { totalDailyQty } from "../core/schedule.js";
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
/** The legacy Access backend (DataBE.accdb) as an import source. */
export async function sourceFromAccdb(file, password) {
    const { default: MDBReader } = await import("mdb-reader");
    const r = new MDBReader(file, password ? { password } : {});
    return { tables: () => r.getTableNames(), rows: (t) => (r.getTableNames().includes(t) ? r.getTable(t).getData() : []) };
}
/** A SQLite mirror of the legacy backend (the demo database db/pharmacy_demo.sqlite) as an import source. */
export function sourceFromMirror(mirror) {
    if (!existsSync(mirror))
        throw new Error(`Not found: ${mirror}`);
    const m = new DatabaseSync(mirror, { readOnly: true });
    const names = m.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    return { tables: () => names, rows: (t) => (names.includes(t) ? m.prepare(`SELECT * FROM "${t}"`).all() : []) };
}
async function openSource() {
    const accdb = arg("--accdb"), mirror = arg("--mirror");
    if (accdb)
        return sourceFromAccdb(readFileSync(accdb), process.env.ACCDB_PASSWORD);
    if (mirror)
        return sourceFromMirror(mirror);
    throw new Error("Pass --accdb <file> or --mirror <legacy sqlite mirror>");
}
const s = (v) => (v == null ? null : String(v).trim() || null);
const n = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const b = (v) => (v === true || v === 1 || v === -1 || v === "1" ? 1 : 0);
/**
 * Access date/times have no zone: they are hospital wall-clock values. mdb-reader returns them as Date objects whose
 * UTC fields hold that wall clock (serial − 25569 days, as UTC), and tools/import_accdb.mjs mirrors them with
 * toISOString() ("…Z"). Read both back with the UTC getters — converting them to the server zone would shift every
 * time by the UTC offset (06:00 → 09:00 in Cairo summer time; bare times on 1899-12-30 → 08:05 with Cairo's LMT).
 * Naive text ("2026-10-07 06:00[:00]") is already wall clock and is kept as is.
 */
const p2 = (x) => String(x).padStart(2, "0");
const wallFromUtc = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
export function dt(v) {
    if (v == null || v === "")
        return null;
    if (v instanceof Date)
        return isNaN(v.getTime()) ? null : wallFromUtc(v);
    const t = String(v).trim();
    if (/[zZ]$/.test(t)) {
        const d = new Date(t);
        return isNaN(d.getTime()) ? null : wallFromUtc(d);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
    if (m)
        return `${m[1]}-${m[2]}-${m[3]}T${p2(Number(m[4] ?? 0))}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : toLocalIso(d);
}
const ORDER_TYPE = { regular: "regular", "وريد مستمر": "cont_drip", "cont.drip": "cont_drip", once: "once", care: "care", operation: "operation" };
const DISPENSE_TYPE = {
    "24h auto": "run_24h", "24h auto-dispense": "run_24h", "auto-dispense session": "run_24h", "auto-dispense": "run_24h",
    "selected times": "selected_times", "mid-day print-dispense": "midday", "drip print-dispense": "drip",
    "manual item dispense": "manual", "walk-in dispense": "walkin", returned: "return",
};
function orderStatus(v) {
    const t = String(v ?? "").trim().toLowerCase();
    if (t === "hold" || t === "معلق")
        return "hold";
    if (t === "stopped" || t === "موقوف" || t === "متوقف")
        return "stopped";
    return "active"; // 'مستمر', 'Active', 'الان', blank
}
export async function importLegacy(target, src, log = console.log) {
    const t0 = Date.now();
    const R = (t) => src.rows(t);
    const stats = {};
    const count = (k) => (stats[k] = (stats[k] ?? 0) + 1);
    const now = nowIso();
    target.tx(() => {
        for (const t of ["chat_messages", "chat_presence", "order_edits_after_dispense", "dispensed_slots", "stock_movements", "dispenses", "walkin_lines", "walkin_tickets",
            "rx_template_lines", "rx_templates", "order_template_lines", "order_templates", "operation_kit_exclusions", "operation_kit_lines",
            "operation_kits", "medication_orders", "batches", "patients", "operations", "items", "departments", "routes", "frequencies",
            "dose_times", "patient_statuses"])
            target.run(`DELETE FROM ${t}`);
        // Keep each user's home pharmacy across re-imports (location ids come from the legacy table and are stable).
        const homes = target.all("SELECT id, location_id FROM users WHERE location_id IS NOT NULL");
        target.run("UPDATE users SET location_id = NULL");
        target.run("DELETE FROM sessions");
        target.run("DELETE FROM locations");
        for (const r of R("pharmacy locations")) {
            target.run("INSERT INTO locations(id,name) VALUES (?,?)", [n(r.LocationID), s(r.LocationName) ?? `صيدلية ${r.LocationID}`]);
            count("locations");
        }
        for (const h of homes)
            target.run("UPDATE users SET location_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM locations WHERE id = ?)", [h.location_id, h.id, h.location_id]);
        const locIds0 = new Set(target.all("SELECT id FROM locations").map((r) => r.id));
        const deptByName = new Map();
        for (const r of R("Department_table")) {
            const name = s(r["Department Name"]);
            if (!name || deptByName.has(name))
                continue;
            const id = target.run("INSERT INTO departments(id,name,location_id) VALUES (?,?,?)", [n(r["Department No"]), name, locIds0.has(n(r["Department Location"])) ? n(r["Department Location"]) : null]).lastId;
            if (!locIds0.has(n(r["Department Location"])))
                count("departments_without_pharmacy");
            deptByName.set(name, id);
            count("departments");
        }
        for (const r of R("Routes"))
            if (s(r.RouteName)) {
                target.run("INSERT OR IGNORE INTO routes(name) VALUES (?)", [s(r.RouteName)]);
                count("routes");
            }
        for (const r of R("Frequencies"))
            if (n(r.FrequencyCode)) {
                target.run("INSERT INTO frequencies(hours,description) VALUES (?,?)", [n(r.FrequencyCode), s(r.DESCRIPTION)]);
                count("frequencies");
            }
        for (const r of R("Dosage Times")) {
            const m = /(\d{1,2}):(\d{2})/.exec(String(r["Day Time"] ?? ""));
            if (!m)
                continue;
            target.run("INSERT OR IGNORE INTO dose_times(time) VALUES (?)", [`${m[1].padStart(2, "0")}:${m[2]}`]);
            count("dose_times");
        }
        for (const r of R("PatientStatuss"))
            if (s(r.PatientStatus)) {
                target.run("INSERT OR IGNORE INTO patient_statuses(name) VALUES (?)", [s(r.PatientStatus)]);
                count("patient_statuses");
            }
        const itemIds = new Set();
        const usedNos = new Set();
        for (const r of R("Items_DB")) {
            const id = s(r.ItemID);
            if (!id || itemIds.has(id))
                continue;
            let no = n(r["رقم الصنف"]) ?? (Number(id.replace(/\D/g, "")) || 0);
            if (!no || usedNos.has(no)) {
                no = Math.max(900000, ...usedNos) + 1;
                count("items_renumbered_duplicate_no");
            }
            usedNos.add(no);
            target.run(`INSERT INTO items(id,item_no,name,selection_name,active_ingredient,strength,strength_unit,form,class,type,unit,special,
        default_dose,default_frequency,default_route,default_notes,use_window,custody_page) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, no, s(r.ItemName) ?? id, s(r["ItemSelection name"]), s(r.AC), s(r["التركيز - الحجم"]), s(r.ConcUnit), s(r.ItemForm), s(r.ItemClass),
                s(r.ItemType), s(r.ItemUnit), s(r.Special), s(r.DefaultDose), n(r.DefaultFrequency), s(r.DefaultRoute), s(r.DefaultNotes), s(r.UseWindow), n(r["صفحة دفتر العهدة"])]);
            itemIds.add(id);
            count("items");
        }
        const ensureItem = (id) => {
            if (!id || itemIds.has(id))
                return id;
            const no = Math.max(800000, ...usedNos) + 1;
            usedNos.add(no);
            target.run("INSERT INTO items(id,item_no,name,active) VALUES (?,?,?,0)", [id, no, `صنف محذوف ${id}`]);
            itemIds.add(id);
            count("items_placeholder_for_missing");
            return id;
        };
        const locIds = new Set(target.all("SELECT id FROM locations").map((r) => r.id));
        const opIds = new Set();
        for (const r of R("Operations")) {
            const loc = n(r.LocationID);
            target.run("INSERT INTO operations(id,op_no,name,location_id,active) VALUES (?,?,?,?,?)", [n(r.OperationID), s(r.OperationNo), s(r.OperationName) ?? "عملية", loc && locIds.has(loc) ? loc : null, b(r.IsActive)]);
            opIds.add(n(r.OperationID));
            count("operations");
        }
        const patientIds = new Set();
        for (const r of R("Patients")) {
            const id = s(r.PatientID);
            if (!id || patientIds.has(id))
                continue;
            const created = dt(r.DateOfCreation) ?? now;
            const op = n(r.OperationID);
            target.run(`INSERT INTO patients(id,name,coverage,department_id,status,diagnosis,dob,is_child,notes,operation_id,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, s(r.PatientName) ?? id, s(r.Coverage), deptByName.get(s(r.Department) ?? "") ?? null, s(r.Status), s(r.Diagnosis),
                r.DOB ? dt(r.DOB)?.slice(0, 10) ?? null : null, b(r.IsChild), s(r.PatientNotes), op && opIds.has(op) ? op : null, b(r.Activity), created, dt(r.LastEditedDate) ?? created]);
            patientIds.add(id);
            count("patients");
            if (s(r.Department) && !deptByName.has(s(r.Department)))
                count("patients_with_unknown_department");
        }
        const orderIds = new Set();
        for (const r of R("MedicationOrders")) {
            const pid = s(r.PatientID), item = s(r.ItemID);
            if (!pid || !item) {
                count("orders_skipped_no_patient_or_item");
                continue;
            }
            if (!patientIds.has(pid)) {
                // Legacy kept orders of patients that were later removed; keep them under an inactive placeholder patient.
                target.run("INSERT INTO patients(id,name,active,created_at,updated_at) VALUES (?,?,0,?,?)", [pid, `مريض غير موجود (${pid})`, now, now]);
                patientIds.add(pid);
                count("patients_placeholder_for_orphan_orders");
            }
            const ot = ORDER_TYPE[String(r.OrderType ?? "regular").trim().toLowerCase()] ?? ORDER_TYPE[String(r.OrderType ?? "").trim()] ?? "regular";
            const startIso = dt(r.StartDateTime) ?? dt(r.FirstScheduledTime) ?? now;
            const firstIso = dt(r.FirstScheduledTime);
            // Legacy stored a bare time (1899-12-30 HH:MM) or a full datetime (kits) in FirstScheduledTime.
            const firstTime = firstIso ? toHHMM(parseLocal(firstIso)) : "06:00";
            const freq = n(r.Frequency);
            const qpd = n(r.QuantityPerDose) ?? 1;
            const dur = n(r.Duration);
            const sec = s(r.SecItemID);
            const kit = n(r.SourceKitID), op = n(r.SourceOperationID);
            target.run(`INSERT INTO medication_orders(id,patient_id,item_id,sec_item_id,dose,frequency_hours,drip_rate,qty_per_dose,total_daily_qty,route,order_type,
          start_date,first_dose_time,duration_days,status,notes,next_dispense_at,display_order,is_auto_from_operation,source_operation_id,source_kit_id,created_at,updated_at,verified_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [n(r.OrderID), pid, ensureItem(item), sec ? ensureItem(sec) : null, s(r.Dose), freq, n(r.DripRate), qpd, totalDailyQty(qpd, freq), s(r.Route), ot,
                startIso.slice(0, 10), firstTime, ot === "once" ? null : dur, orderStatus(r.Status), s(r.Notes), dt(r["NextDispense Time"]),
                n(r.DisplayOrder) ?? 0, b(r.IsAutoFromOperation), op && opIds.has(op) ? op : null, kit, startIso, startIso,
                startIso]); // orders from the old system count as checked (release 1.9 verification is for new and changed orders)
            orderIds.add(n(r.OrderID));
            count("orders");
        }
        const batchIds = new Set();
        for (const r of R("ItemBatches")) {
            const item = s(r.ItemID), loc = n(r.LocationID);
            if (!item || !loc || !locIds.has(loc)) {
                count("batches_skipped");
                continue;
            }
            const exp = r.ExpiryDate ? dt(r.ExpiryDate).slice(0, 10) : null;
            try {
                target.run("INSERT INTO batches(id,item_id,location_id,batch_no,expiry_date,qty,is_placeholder,created_at) VALUES (?,?,?,?,?,?,?,?)", [n(r.BatchID), ensureItem(item), loc, s(r.BatchNo) ?? "?", exp, Math.max(0, n(r.Qty) ?? 0), b(r.IsPlaceholder), dt(r.DateAdded) ?? now]);
                // Opening balance as an 'import' movement so SUM(qty_delta) per batch always equals batches.qty.
                if ((n(r.Qty) ?? 0) > 0)
                    target.run("INSERT INTO stock_movements(at,batch_id,kind,qty_delta,note) VALUES (?,?,'import',?,?)", [now, n(r.BatchID), n(r.Qty), "Opening balance from the old system"]);
                batchIds.add(n(r.BatchID));
                count("batches");
            }
            catch {
                count("batches_duplicate_key_skipped");
            }
        }
        const nameById = new Map(target.all("SELECT id,name FROM patients").map((p) => [p.id, p.name]));
        for (const r of R("Temp_WalkInLines"))
            if (s(r.PatientID) && s(r.PatientName) && !nameById.has(s(r.PatientID)))
                nameById.set(s(r.PatientID), s(r.PatientName));
        const ticketIds = new Set();
        const ticketHeader = new Map();
        for (const r of R("Temp_WalkInLines"))
            if (!ticketHeader.has(n(r.TicketID)))
                ticketHeader.set(n(r.TicketID), r);
        for (const r of R("WalkInTickets")) {
            const id = n(r.TicketID);
            const h = ticketHeader.get(id);
            if (!h) {
                count("walkin_empty_tickets_skipped");
                continue;
            }
            const loc = n(r.LocationID);
            target.run("INSERT INTO walkin_tickets(id,created_at,location_id,patient_ref,patient_name) VALUES (?,?,?,?,?)", [id, dt(r.CreatedAt) ?? now, loc && locIds.has(loc) ? loc : [...locIds][0], s(h.PatientID), s(h.PatientName)]);
            ticketIds.add(id);
            count("walkin_tickets");
        }
        // Legacy tickets were dispensed in the old system (its DispenseHistory rows are imported below without a ticket link):
        // record every to-dispense line as fully dispensed and the ticket as dispensed at its creation time, so pressing
        // dispense on an old ticket does not take the stock a second time. Print-only lines were never dispensed.
        for (const r of R("Temp_WalkInLines")) {
            const t = n(r.TicketID);
            if (!t || !ticketIds.has(t))
                continue;
            const qty = n(r.Qty) ?? 1, toDispense = b(r.ToDispense), item = ensureItem(s(r.ItemID));
            target.run(`INSERT INTO walkin_lines(ticket_id,line_no,item_id,route,conc,unit,qty,notes,to_dispense,to_print,dispensed_qty,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [t, n(r.LineNo) ?? 0, item, s(r.Route), s(r.Conc), s(r.Unit), qty, s(r.Notes), toDispense, b(r.ToPrint),
                toDispense && item && qty > 0 ? qty : 0, dt(r.CreatedAt) ?? now]);
            count("walkin_lines");
        }
        target.run(`UPDATE walkin_tickets SET dispensed_at = created_at
      WHERE EXISTS (SELECT 1 FROM walkin_lines l WHERE l.ticket_id = walkin_tickets.id AND l.dispensed_qty > 0)`);
        for (const r of R("DispenseHistory")) {
            const item = s(r.ItemID), loc = n(r.LocationID);
            if (!item || !loc || !locIds.has(loc)) {
                count("dispenses_skipped");
                continue;
            }
            const type = DISPENSE_TYPE[String(r.DispenseType ?? "").trim().toLowerCase()] ?? "manual";
            const pid = s(r.PatientID);
            const oid = n(r.OrderID);
            const bid = n(r.BatchID);
            target.run(`INSERT INTO dispenses(id,at,location_id,patient_id,patient_name,order_id,item_id,batch_id,qty,type,run_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [n(r.DispenseID), dt(r.DispenseDateTime) ?? now, loc, pid, pid ? nameById.get(pid) ?? null : null, oid && orderIds.has(oid) ? oid : null,
                ensureItem(item), bid && batchIds.has(bid) ? bid : null, n(r.QuantityDispensed) ?? 0, type, `legacy-${r.DispenseID}`, s(r.Notes)]);
            count("dispenses");
        }
        for (const r of R("MedOrderTemplates")) {
            const loc = n(r.LocationID);
            if (!loc || !locIds.has(loc))
                continue;
            target.run("INSERT INTO order_templates(id,name,location_id,active) VALUES (?,?,?,?)", [n(r.TemplateID), s(r.TemplateName) ?? "قالب", loc, b(r.Active)]);
            count("order_templates");
        }
        const otIds = new Set(target.all("SELECT id FROM order_templates").map((x) => x.id));
        for (const r of R("MedOrderTemplateLines")) {
            if (!otIds.has(n(r.TemplateID)) || !s(r.ItemID))
                continue;
            const ft = dt(r.FirstScheduledTime);
            target.run(`INSERT INTO order_template_lines(template_id,item_id,sec_item_id,dose,qty_per_dose,frequency_hours,drip_rate,route,duration_days,order_type,notes,first_dose_time,display_offset)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [n(r.TemplateID), ensureItem(s(r.ItemID)), s(r.SecItemID) ? ensureItem(s(r.SecItemID)) : null, s(r.Dose), n(r.QuantityPerDose), n(r.Frequency), n(r.DripRate), s(r.Route), n(r.Duration),
                ORDER_TYPE[String(r.OrderType ?? "").trim().toLowerCase()] ?? null, s(r.Notes), ft ? toHHMM(parseLocal(ft)) : null, n(r.DisplayOrderOffset) ?? 0]);
            count("order_template_lines");
        }
        for (const r of R("OperationKits")) {
            const loc = n(r.LocationID), op = n(r.OperationID);
            if (!loc || !locIds.has(loc) || !op || !opIds.has(op))
                continue;
            try {
                target.run("INSERT INTO operation_kits(id,operation_id,location_id,active,notes) VALUES (?,?,?,?,?)", [n(r.KitID), op, loc, b(r.IsActive), s(r.Notes)]);
                count("operation_kits");
            }
            catch {
                count("operation_kits_duplicate_skipped");
            }
        }
        const kitIds = new Set(target.all("SELECT id FROM operation_kits").map((x) => x.id));
        for (const r of R("OperationKitLines")) {
            if (!kitIds.has(n(r.KitID)) || !s(r.ItemID))
                continue;
            target.run("INSERT INTO operation_kit_lines(kit_id,item_id,default_qty,active) VALUES (?,?,?,?)", [n(r.KitID), ensureItem(s(r.ItemID)), n(r.DefaultQty) ?? 1, b(r.IsActive)]);
            count("operation_kit_lines");
        }
        for (const r of R("OperationKitExclusions")) {
            const loc = n(r.LocationID);
            if (!loc || !locIds.has(loc) || !s(r.ItemID))
                continue;
            target.run("INSERT INTO operation_kit_exclusions(location_id,item_id,active,reason) VALUES (?,?,?,?)", [loc, ensureItem(s(r.ItemID)), b(r.IsActive), s(r.Reason)]);
            count("operation_kit_exclusions");
        }
        for (const r of R("RxTemplates")) {
            const loc = n(r.LocationID);
            if (!loc || !locIds.has(loc))
                continue;
            target.run("INSERT INTO rx_templates(id,name,location_id,active) VALUES (?,?,?,?)", [n(r.TemplateID), s(r.TemplateName) ?? "قالب", loc, b(r.Active)]);
            count("rx_templates");
        }
        const rxIds = new Set(target.all("SELECT id FROM rx_templates").map((x) => x.id));
        let ln = 0;
        for (const r of R("RxTemplateLines")) {
            if (!rxIds.has(n(r.TemplateID)) || !s(r.ItemID))
                continue;
            target.run("INSERT INTO rx_template_lines(template_id,line_no,item_id,qty,notes,route,conc,unit) VALUES (?,?,?,?,?,?,?,?)", [n(r.TemplateID), ++ln, ensureItem(s(r.ItemID)), n(r.Qty) ?? 1, s(r.Notes), s(r.Route), s(r.Conc), s(r.Unit)]);
            count("rx_template_lines");
        }
        for (const r of R("ChatMessages")) {
            const from = n(r.FromLocationID), to = n(r.ToLocationID);
            if (!s(r.MsgText))
                continue;
            target.run("INSERT INTO chat_messages(room_id,from_location_id,to_location_id,body,created_at) VALUES (1,?,?,?,?)", [from && locIds.has(from) ? from : null, to && locIds.has(to) ? to : null, s(r.MsgText), dt(r.CreatedAt) ?? now]);
            count("chat_messages");
        }
        target.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('legacy_import_at', ?)", [now]);
        // walk-in lines above are already recorded as dispensed: the startup fix for older imports has nothing to do
        target.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('legacy_walkins_dispensed_for', ?)", [now]);
    });
    log(`Imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [k, v] of Object.entries(stats))
        log(`  ${k}: ${v}`);
    return stats;
}
if (process.argv[1] && /import-legacy\.(ts|js)$/.test(process.argv[1])) {
    const target = openDb(arg("--db") ?? process.env.DB_FILE ?? "data/pharmacy.sqlite");
    const src = await openSource();
    await importLegacy(target, src);
    target.close();
}
