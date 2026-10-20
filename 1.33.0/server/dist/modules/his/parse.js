// Reading what the hospital system (HIS) sends (release 1.14, plan item 41): admissions, transfers, discharges and
// doctors' medication orders, in three forms — a CSV file (the simplest export most systems can make), HL7 v2
// messages (ADT for patients, RDE / OMP for pharmacy orders) and FHIR R4 JSON (Patient, Encounter, MedicationRequest,
// one resource or a Bundle). Each becomes the same plain message (HisMsg); apply.ts decides what to do with it.
// Nothing here touches the database.
const clean = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => { const s = clean(v).replace(",", "."); if (!s)
    return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };
const sexOf = (v) => { const s = clean(v).toUpperCase(); return s.startsWith("M") || s === "ذكر" ? "M" : s.startsWith("F") || s === "أنثى" ? "F" : undefined; };
/** YYYY-MM-DD from YYYYMMDD[hhmm…], YYYY-MM-DD[T…] or DD/MM/YYYY. */
export function dateOf(v) {
    const s = clean(v);
    let y, mo, d;
    let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
    if (m)
        [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)))
        [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
    else
        return undefined;
    // a real calendar day only (13/25/2024 is not one)
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (y < 1900 || y > 2100 || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
        return undefined;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** HH:MM from HH:MM, HHMM, or the time part of YYYYMMDDHHMM / an ISO datetime. */
export function timeOf(v) {
    const s = clean(v);
    // an ISO time with a zone (…Z, …+02:00) is that moment on this server's clock
    if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
        const t = new Date(s);
        if (!Number.isNaN(t.getTime()))
            return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    }
    let m = /^(\d{1,2}):(\d{2})/.exec(s) ?? /T(\d{2}):(\d{2})/.exec(s) ?? /^\d{8}(\d{2})(\d{2})/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
    if (!m)
        return undefined;
    const h = Number(m[1]), mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${m[2]}` : undefined;
}
/**
 * Hours between doses from the usual ways of writing it: Q8H, q8h, BID/BD, TID/TDS, QID/QDS, QD/OD, daily, "every 6
 * hours", Q4-6H (the longer interval: the safer one), with PRN ignored. A bare number means hours when the column says
 * hours (every_hours) and times a day when it says frequency ("3" = three times a day).
 */
export function frequencyOf(v, bare = "hours") {
    const s = clean(v).toUpperCase().replace(/\s+/g, "").replace(/PRN$|^PRN/, "");
    if (!s)
        return {};
    if (/^(ONCE|STAT|NOW|X1|1X)$/.test(s))
        return { once: true };
    const named = { QD: 24, OD: 24, DAILY: 24, QDAY: 24, BID: 12, BD: 12, TID: 8, TDS: 8, QID: 6, QDS: 6, QHS: 24, Q2D: 48, QOD: 48, WEEKLY: 168 };
    if (named[s])
        return { hours: named[s] };
    let m = /^Q?(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?H(?:RS?|OURS?)?$/.exec(s) ?? /^EVERY(\d+(?:\.\d+)?)H(?:OURS?)?$/.exec(s);
    if (m)
        return { hours: Math.max(Number(m[1]), Number(m[2] ?? 0)) };
    m = /^Q?(\d+)MIN$/.exec(s);
    if (m)
        return { hours: Number(m[1]) / 60 };
    m = /^(\d+)[X*]?(?:DAILY|\/DAY|PERDAY)?$/.exec(s) ?? /^[X*]?(\d+)$/.exec(s);
    const n = m ? Number(m[1]) : NaN;
    if (!(n > 0))
        return {};
    return bare === "times" ? { hours: 24 / n } : { hours: n };
}
/* ---------------- CSV ---------------- */
/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes); the separator is guessed from the header (, ; or tab). */
export function readCsv(text) {
    const t = text.replace(/^﻿/, "");
    const first = t.split(/\r?\n/, 1)[0] ?? "";
    const sep = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (q) {
            if (c === '"') {
                if (t[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else
                    q = false;
            }
            else
                cell += c;
        }
        else if (c === '"' && cell === "")
            q = true; // a quote opens a quoted cell only at its start
        else if (c === sep) {
            row.push(cell);
            cell = "";
        }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && t[i + 1] === "\n")
                i++;
            row.push(cell);
            cell = "";
            if (row.some((x) => x.trim()))
                rows.push(row);
            row = [];
        }
        else
            cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim()))
        rows.push(row);
    return rows;
}
// the header names the hospital system may use for each column
const COLS = {
    event: ["event", "type", "action", "message"], patientId: ["patient_id", "patientid", "mrn", "patient", "id"],
    name: ["name", "patient_name"], dob: ["dob", "birth_date", "date_of_birth"], sex: ["sex", "gender"],
    weightKg: ["weight_kg", "weight"], heightCm: ["height_cm", "height"], department: ["department", "ward", "unit", "location"],
    ref: ["order_id", "order_no", "ref", "his_order_id", "visit_id", "encounter_id"], drug: ["drug_code", "item_code", "drug", "code"],
    drugName: ["drug_name", "item_name", "medication"], dose: ["dose"], qtyPerDose: ["qty_per_dose"],
    everyHours: ["every_hours", "interval_hours"], frequency: ["frequency", "freq"], route: ["route"], startDate: ["start_date", "start"], firstDoseTime: ["first_dose", "first_dose_time", "time"],
    durationDays: ["days", "duration_days", "duration"], notes: ["notes", "instructions", "sig"], prescriber: ["prescriber", "doctor"],
};
const EVENTS = {
    admit: "admit", admission: "admit", a01: "admit", a04: "admit", update: "update", a08: "update", transfer: "transfer", a02: "transfer",
    discharge: "discharge", a03: "discharge", order: "order", new: "order", nw: "order", cancel: "cancel", ca: "cancel", dc: "cancel", stop: "cancel",
};
export function parseCsv(text, defaultKind) {
    const rows = readCsv(text);
    if (!rows.length)
        return [];
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
    const col = {};
    for (const [k, names] of Object.entries(COLS)) {
        const i = head.findIndex((h) => names.includes(h));
        if (i >= 0)
            col[k] = i;
    }
    if (col.patientId == null)
        return [{ error: "The file has no patient ID column (patient_id)", raw: rows[0].join(",") }];
    return rows.slice(1).map((r) => {
        const g = (k) => (col[k] != null ? clean(r[col[k]]) : "");
        const raw = r.join(",");
        const kind = EVENTS[g("event").toLowerCase()] ?? (col.event == null ? defaultKind ?? (g("drug") ? "order" : "admit") : undefined);
        if (!kind)
            return { error: `Unknown event "${g("event")}"`, raw };
        return toMsg(kind, {
            ref: g("ref"), patientId: g("patientId"), name: g("name"), dob: g("dob"), sex: g("sex"), weightKg: g("weightKg"), heightCm: g("heightCm"),
            department: g("department"), drug: g("drug"), drugName: g("drugName"), dose: g("dose"), qtyPerDose: g("qtyPerDose"),
            frequency: g("everyHours") ? frequencyOf(g("everyHours"), "hours") : frequencyOf(g("frequency"), "times"),
            route: g("route"), startDate: g("startDate"), firstDoseTime: g("firstDoseTime"), durationDays: g("durationDays"), notes: g("notes"), prescriber: g("prescriber"),
        }, raw);
    });
}
/** Builds and checks a message from loose fields (CSV, HL7 and FHIR all end here). */
function toMsg(kind, f, raw) {
    const patientId = clean(f.patientId);
    if (!patientId)
        return { error: "No patient ID", raw };
    if (patientId.length > 30)
        return { error: `Patient ID "${patientId.slice(0, 40)}" is too long`, raw };
    const ref = clean(f.ref) || undefined;
    if (kind === "discharge")
        return { msg: { kind, ref, patientId } };
    if (kind === "cancel")
        return ref ? { msg: { kind, ref, patientId } } : { error: "A cancellation needs the order's number", raw };
    if (kind === "admit" || kind === "transfer" || kind === "update") {
        // measurements the safety checks rely on: only in the range a person can have (a weight in grams is not 3500 kg)
        const w = num(f.weightKg), h = num(f.heightCm);
        return { msg: { kind, ref, patientId, name: clean(f.name) || undefined, dob: dateOf(f.dob), sex: sexOf(f.sex),
                weightKg: w != null && w >= 0.2 && w <= 400 ? w : undefined, heightCm: h != null && h >= 20 && h <= 260 ? h : undefined,
                department: kind === "update" ? undefined : clean(f.department) || undefined } };
    }
    const drug = clean(f.drug) || clean(f.drugName);
    if (!drug)
        return { error: "An order needs the drug's code or name", raw };
    const fr = typeof f.frequency === "object" && f.frequency ? f.frequency : frequencyOf(f.frequency);
    return { msg: { kind: "order", ref, patientId, drug, drugName: clean(f.drugName) || undefined, dose: clean(f.dose) || undefined, qtyPerDose: num(f.qtyPerDose),
            frequencyHours: fr.hours, once: fr.once, route: clean(f.route) || undefined, startDate: dateOf(f.startDate), firstDoseTime: timeOf(f.firstDoseTime) ?? timeOf(f.startDate),
            durationDays: num(f.durationDays), notes: clean(f.notes) || undefined, prescriber: clean(f.prescriber) || undefined } };
}
/* ---------------- HL7 v2 ---------------- */
/** Splits HL7 v2 text into messages, each a list of segments (fields split on |, components on ^). */
function hl7Messages(text) {
    const segs = text.replace(/^﻿/, "").split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const s of segs) {
        const f = s.split("|");
        if (f[0] === "MSH")
            out.push([]);
        if (!out.length)
            continue;
        // MSH's field 1 is the separator itself: shift so MSH-9 is f[9] like every other segment's numbering
        out[out.length - 1].push(f[0] === "MSH" ? ["MSH", "|", ...f.slice(1)] : f);
    }
    return out;
}
/** HL7 escapes (\F\ | \S\ ^ \T\ & \R\ ~ \E\ \) decoded. */
const unescape = (s) => s.replace(/\\([FSTRE])\\/g, (_m, c) => ({ F: "|", S: "^", T: "&", R: "~", E: "\\" }[c]));
const comp = (field, i = 0) => clean(unescape((field ?? "").split("~")[0].split("^")[i] ?? ""));
/** PID-3: the repeat whose identifier type is MR (the medical record number), else the first. */
const mrOf = (field) => {
    const reps = (field ?? "").split("~");
    const mr = reps.find((r) => (r.split("^")[4] ?? "").toUpperCase() === "MR") ?? reps[0];
    return clean(unescape((mr ?? "").split("^")[0]));
};
export function parseHl7(text) {
    return hl7Messages(text).flatMap((segs) => {
        const seg = (name) => segs.find((s) => s[0] === name);
        const raw = segs.map((s) => s.join("|")).join("\r").slice(0, 400);
        const msh = seg("MSH"), pid = seg("PID"), pv1 = seg("PV1");
        const type = `${comp(msh?.[9], 0)}^${comp(msh?.[9], 1)}`.toUpperCase();
        const patientId = mrOf(pid?.[3]);
        const name = [comp(pid?.[5], 1), comp(pid?.[5], 2), comp(pid?.[5], 0)].filter(Boolean).join(" ");
        const pf = { patientId, name, dob: comp(pid?.[7]), sex: comp(pid?.[8]), department: comp(pv1?.[3]) || comp(pv1?.[10]), ref: comp(pv1?.[19]) };
        if (/^ADT\^A0[14]$/.test(type))
            return [toMsg("admit", pf, raw)];
        if (type === "ADT^A08" || type === "ADT^A31")
            return [toMsg("update", pf, raw)];
        if (type === "ADT^A02")
            return [toMsg("transfer", pf, raw)];
        if (/^ADT\^A0[3]$/.test(type) || type === "ADT^A11")
            return [toMsg("discharge", pf, raw)];
        if (/^(RDE|OMP|RDS)\^/.test(type)) {
            // one message may hold several orders: each ORC starts one, with its RXE/RXO, RXR and TQ1 after it
            const orders = [];
            for (const s of segs) {
                if (s[0] === "ORC")
                    orders.push([s]);
                else if (orders.length && ["RXE", "RXO", "RXR", "TQ1", "RXC", "NTE"].includes(s[0]))
                    orders[orders.length - 1].push(s);
            }
            return orders.map((o) => {
                const get = (n) => o.find((s) => s[0] === n);
                const orc = get("ORC"), rxe = get("RXE"), rxo = get("RXO"), rxr = get("RXR"), tq1 = get("TQ1"), nte = get("NTE");
                const control = comp(orc[1]).toUpperCase();
                const ref = comp(orc[2]) || comp(orc[3]);
                // cancelled, discontinued, held: the pharmacist acts on it; a change (XO, RP) is an order sent again with new details
                if (["CA", "DC", "OD", "OC", "HD", "OH"].includes(control))
                    return toMsg("cancel", { patientId, ref }, raw);
                // RXE-2 give code^text, RXE-3 amount, RXE-5 units; RXE-1 (old) or TQ1-3 repeat pattern (Q8H…), TQ1-7 start
                const give = rxe?.[2] ?? rxo?.[1];
                const amount = comp(rxe?.[3]) || comp(rxo?.[2]);
                const units = comp(rxe?.[5], 1) || comp(rxe?.[5]) || comp(rxo?.[4], 1) || comp(rxo?.[4]);
                const repeat = comp(tq1?.[3]) || comp(rxe?.[1], 1);
                const start = comp(tq1?.[7]) || comp(rxe?.[1], 3) || comp(orc[9]);
                return toMsg("order", { patientId, ref, drug: comp(give, 0), drugName: comp(give, 1), dose: amount ? `${amount} ${units}`.trim() : "",
                    frequency: repeat, route: comp(rxr?.[1], 1) || comp(rxr?.[1], 0), startDate: start, firstDoseTime: start, notes: comp(nte?.[3]),
                    prescriber: [comp(orc[12], 2), comp(orc[12], 1)].filter(Boolean).join(" ") }, raw);
            });
        }
        return [{ error: `HL7 message ${type} is not one this link reads`, raw }];
    });
}
/* ---------------- FHIR R4 ---------------- */
export function parseFhir(text) {
    let doc;
    try {
        doc = JSON.parse(text.replace(/^﻿/, ""));
    }
    catch {
        return [{ error: "Not valid JSON", raw: text.slice(0, 200) }];
    }
    const res = doc?.resourceType === "Bundle" ? (doc.entry ?? []).map((e) => e?.resource).filter(Boolean) : [doc];
    // Patient/123 → the hospital's patient ID (an MR identifier, else the first identifier, else the id)
    const ids = new Map();
    for (const r of res)
        if (r?.resourceType === "Patient") {
            const idf = (r.identifier ?? []).find((i) => i?.type?.coding?.some((c) => c?.code === "MR")) ?? r.identifier?.[0];
            // the hospital's own number only: a FHIR resource id is the server's, and could match another patient here
            if (clean(idf?.value))
                ids.set(`Patient/${r.id}`, clean(idf.value));
        }
    const pidOf = (ref) => ids.get(clean(ref)) ?? "";
    const out = [];
    for (const r of res) {
        const raw = JSON.stringify(r).slice(0, 400);
        if (r?.resourceType === "Encounter") {
            const patientId = pidOf(r.subject?.reference);
            const patient = res.find((p) => p?.resourceType === "Patient" && ids.get(`Patient/${p.id}`) === patientId);
            const name = patient?.name?.[0]?.text ?? [...(patient?.name?.[0]?.given ?? []), patient?.name?.[0]?.family].filter(Boolean).join(" ");
            const dept = r.location?.[0]?.location?.display ?? r.serviceType?.coding?.[0]?.display ?? r.serviceType?.text;
            // admitted while in progress or arrived; a planned, cancelled or mistaken visit changes nothing here
            const kind = r.status === "finished" || r.status === "completed" ? "discharge" : r.status === "in-progress" || r.status === "arrived" ? "admit" : null;
            if (!kind) {
                out.push({ ignore: `Encounter ${r.status ?? "without status"}` });
                continue;
            }
            out.push(toMsg(kind, { patientId, name, dob: patient?.birthDate, sex: patient?.gender, department: dept, ref: r.id }, raw));
        }
        else if (r?.resourceType === "MedicationRequest") {
            const patientId = pidOf(r.subject?.reference);
            const ref = clean(r.identifier?.[0]?.value) || clean(r.id);
            if (["cancelled", "stopped", "entered-in-error", "on-hold"].includes(r.status)) {
                out.push(toMsg("cancel", { patientId, ref }, raw));
                continue;
            }
            if (r.status !== "active") {
                out.push({ ignore: `MedicationRequest ${r.status ?? "without status"}` });
                continue;
            }
            const med = r.medicationCodeableConcept ?? {};
            const di = r.dosageInstruction?.[0] ?? {};
            const rep = di.timing?.repeat ?? {};
            const per = { h: 1, min: 1 / 60, d: 24, wk: 168 }[rep.periodUnit];
            const hours = rep.frequency && rep.period && per ? (rep.period * per) / rep.frequency : undefined;
            const dq = di.doseAndRate?.[0]?.doseQuantity;
            const start = rep.boundsPeriod?.start ?? r.authoredOn;
            out.push(toMsg("order", { patientId, ref, drug: med.coding?.[0]?.code, drugName: med.coding?.[0]?.display ?? med.text,
                dose: dq?.value != null ? `${dq.value} ${dq.unit ?? ""}`.trim() : "", frequency: hours ?? di.timing?.code?.text,
                route: di.route?.text ?? di.route?.coding?.[0]?.display, startDate: start, firstDoseTime: rep.timeOfDay?.[0] ?? start,
                durationDays: rep.boundsDuration?.unit === "d" ? rep.boundsDuration.value : undefined, notes: di.text, prescriber: r.requester?.display }, raw));
        }
        else if (r?.resourceType === "Patient" && res.length === 1) {
            // a Patient on its own is an update of what is known, not an admission
            out.push(toMsg("update", { patientId: ids.get(`Patient/${r.id}`), name: r.name?.[0]?.text, dob: r.birthDate, sex: r.gender }, raw));
        }
    }
    return out;
}
/** By the file's name and content: .hl7 / MSH… → HL7, .json / { → FHIR, else CSV ("admissions…", "orders…" names set the default kind). */
export function parseFile(name, text) {
    const n = name.toLowerCase(), t = text.replace(/^﻿/, "").trimStart();
    if (n.endsWith(".hl7") || t.startsWith("MSH|"))
        return parseHl7(text);
    if (n.endsWith(".json") || t.startsWith("{"))
        return parseFhir(text);
    const def = /discharg/.test(n) ? "discharge" : /admi/.test(n) ? "admit" : /transf/.test(n) ? "transfer" : /order|rx|presc/.test(n) ? "order" : undefined;
    return parseCsv(text, def);
}
