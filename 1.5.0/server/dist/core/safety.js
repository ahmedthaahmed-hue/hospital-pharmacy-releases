import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { nowIso, now as clockNow } from "../lib/time.js";
import { accessOf } from "../auth/access.js";
import { checkUserPassword } from "../auth/passwords.js";
import { throttledCheck } from "../lib/rate-limit.js";
import { anchorOf, endOf, isSingleDose, medicalDay } from "./schedule.js";
import { settingBool, settingStr } from "./settings.js";
const ITEM_SAFETY_COLS = `id, name, selection_name, active_ingredient, class, strength, strength_unit, high_alert, tall_man_name,
  dose_unit, max_single_dose, max_daily_dose, max_single_per_kg, max_daily_per_kg`;
/**
 * Text for comparing names: NFKC, lower case, and the Arabic spellings that vary folded together (أ إ آ ٱ → ا, ة → ه,
 * ى → ي, no tashkeel or tatweel), so "إيبوبروفين" and "أيبوبروفين" are one ingredient.
 */
export const norm = (s) => (s ?? "").normalize("NFKC").toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/\s+/g, " ").trim();
/** The active ingredients of an item: "Amoxicillin + Clavulanic acid" → ["amoxicillin", "clavulanic acid"]. */
export function ingredients(ai) {
    return norm(ai).split(/\s*(?:\+|,|\/|&|\band\b|،|\sو\s)\s*/).map((s) => s.trim()).filter((s) => s.length > 1);
}
/** A name inside an English message, isolated so an Arabic name does not reorder the sentence around it. */
const iso = (t) => `\u2068${t ?? ""}\u2069`;
const shownName = (i) => i.tall_man_name || i.selection_name || i.name;
/** Two ingredients are the same: equal, or one contains the other ("penicillin" in "benzylpenicillin"; long names only). */
const sameIngredient = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)));
const inNames = (i, v) => v.length >= 4 && [i.name, i.selection_name].some((t) => norm(t).includes(v));
/** Does item `i` match an allergy or a rule side (kind, value)? */
function matches(i, kind, value) {
    const v = norm(value);
    if (!v)
        return false;
    if (kind === "class")
        return norm(i.class) === v || (v.length >= 4 && norm(i.class).includes(v));
    const ais = ingredients(i.active_ingredient);
    // an item with no ingredient recorded: its names are all there is to go by
    if (!ais.length)
        return kind !== "class" && inNames(i, v);
    // a combination written as the value ("A + B") matches an item that contains every part of it
    const parts = ingredients(value);
    if (kind === "ingredient" && parts.length > 1)
        return parts.every((x) => ais.some((a) => sameIngredient(a, x)));
    if (ais.some((a) => a === v || (v.length >= 5 && a.includes(v))))
        return true;
    if (kind === "other")
        return [i.name, i.selection_name, i.active_ingredient, i.class].some((t) => v.length >= 3 && norm(t).includes(v));
    return false;
}
// ---- dose amounts
const UNIT = {
    // (keys as norm() leaves them: NFKC turns the micro sign µ into the Greek μ)
    mcg: { family: "mass", f: 0.001 }, "μg": { family: "mass", f: 0.001 }, "µg": { family: "mass", f: 0.001 }, ug: { family: "mass", f: 0.001 },
    microgram: { family: "mass", f: 0.001 }, "ميكجم": { family: "mass", f: 0.001 }, "مكجم": { family: "mass", f: 0.001 },
    "ميكروجرام": { family: "mass", f: 0.001 }, "ميكروجم": { family: "mass", f: 0.001 },
    mg: { family: "mass", f: 1 }, milligram: { family: "mass", f: 1 }, "مجم": { family: "mass", f: 1 }, "ملجم": { family: "mass", f: 1 },
    "ملغ": { family: "mass", f: 1 }, "ملغم": { family: "mass", f: 1 }, "مليجرام": { family: "mass", f: 1 },
    g: { family: "mass", f: 1000 }, gm: { family: "mass", f: 1000 }, gram: { family: "mass", f: 1000 }, "جم": { family: "mass", f: 1000 }, "جرام": { family: "mass", f: 1000 },
    ml: { family: "volume", f: 1 }, cc: { family: "volume", f: 1 }, "مل": { family: "volume", f: 1 }, "ملل": { family: "volume", f: 1 }, l: { family: "volume", f: 1000 },
    iu: { family: "unit", f: 1 }, unit: { family: "unit", f: 1 }, units: { family: "unit", f: 1 }, u: { family: "unit", f: 1 }, "وحدة": { family: "unit", f: 1 },
    mmol: { family: "mmol", f: 1 }, meq: { family: "meq", f: 1 },
};
const unitOf = (u) => UNIT[norm(u).replace(/s$/, "") === "unit" ? "unit" : norm(u)] ?? UNIT[norm(u).replace(/\.$/, "")];
/**
 * Numbers as written in the catalogue and in doses, made plain: Arabic-Indic digits and separators; "1,000" and
 * "25,000" (a comma before exactly three digits) are thousands; any other comma is a decimal sign ("0,5"); a leading
 * decimal sign (",25" / ".5" in the old catalogue) is a fraction.
 */
const digits = (s) => s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
    .replace(/٬/g, ",").replace(/٫/g, ".")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/(^|[^\d])[.,](\d)/g, (_m, a, b) => `${a}0.${b}`);
/** "500 mg" / "1 g" / "0.5" → { value, unit } (unit may be null). Ranges ("1-2 tabs") take the higher number. */
export function parseAmount(text) {
    if (!text)
        return null;
    const m = /(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*([a-zµμ\u0600-\u06ff]+)?/i.exec(digits(text));
    if (!m)
        return null;
    const value = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0);
    return Number.isFinite(value) ? { value, unit: m[3] ?? null } : null;
}
/** An amount converted to `target` (mg ↔ g ↔ mcg, mL ↔ L); null when the units do not convert. */
export function convert(value, from, target) {
    const t = unitOf(target);
    if (!t)
        return null;
    if (!from)
        return null;
    const f = unitOf(from);
    if (!f || f.family !== t.family)
        return null;
    return (value * f.f) / t.f;
}
/**
 * The amount of one dose in the item's dose unit: the order's dose when it says one ("500 mg", "1 g"), or the quantity
 * per dose times the item's strength when that is in a unit that converts ("2" tablets of "500" "mg"). Null when it
 * cannot be told.
 */
export function doseAmount(i, c) {
    if (!i.dose_unit)
        return null;
    const d = parseAmount(c.dose);
    if (d && d.unit) {
        const v = convert(d.value, d.unit, i.dose_unit);
        if (v != null)
            return v;
        // a liquid measured by volume ("20 ml") of a solution "250 mg / 5 ml": volume × concentration, or unknown
        const ml = convert(d.value, d.unit, "ml");
        if (ml != null) {
            const per = concentration(i);
            if (!per)
                return null;
            const mass = convert(per.value, per.unit, i.dose_unit);
            return mass == null ? null : (ml * mass) / per.perMl;
        }
    }
    const s = parseAmount(i.strength);
    const qpd = c.qtyPerDose && c.qtyPerDose > 0 ? c.qtyPerDose : 1;
    if (s) {
        const v = convert(s.value, s.unit ?? i.strength_unit, i.dose_unit);
        if (v != null)
            return v * qpd;
    }
    // a bare number in the dose ("500") is read in the item's dose unit
    if (d && !d.unit)
        return d.value;
    return null;
}
const fmt = (n) => String(Math.round(n * 100) / 100);
/** "250 mg / 5 ml" in the item's strength, strength unit or name: the amount per so many mL. */
export function concentration(i) {
    for (const t of [`${i.strength ?? ""} ${i.strength_unit ?? ""}`, i.strength ?? "", i.name]) {
        const m = /(\d+(?:\.\d+)?)\s*([a-zµμ\u0600-\u06ff]+)\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-z\u0600-\u06ff]+)/i.exec(digits(t));
        if (!m)
            continue;
        const per = convert(m[3] ? Number(m[3]) : 1, m[4], "ml");
        if (per && unitOf(m[2]))
            return { value: Number(m[1]), unit: m[2], perMl: per };
    }
    return null;
}
/** The patient's running orders (not ended), with their items. */
function runningOrders(d, patientId) {
    const day = settingStr("schedule.day_start") || "06:00";
    const now = clockNow();
    const rows = d.all(`SELECT o.*, o.id AS order_id, ${ITEM_SAFETY_COLS.split(",").map((c) => `i.${c.trim()}`).join(", ")}
     FROM medication_orders o JOIN items i ON i.id = o.item_id WHERE o.patient_id = ? AND o.status = 'active'`, [patientId]);
    return rows.filter((o) => {
        if ((o.order_type === "once" || o.order_type === "operation") && isSingleDose(o))
            return medicalDay(anchorOf(o), day).end.getTime() > now.getTime();
        const e = endOf(o);
        return !e || e.getTime() > now.getTime();
    }).map((o) => ({ ...o, id: o.item_id }));
}
/** Every safety alert for these medicines (empty when the checks are switched off). */
export function safetyAlerts(d, input) {
    if (!settingBool("safety.enabled") || !input.candidates.length)
        return [];
    const ids = [...new Set(input.candidates.map((c) => c.itemId))];
    const items = new Map(d.all(`SELECT ${ITEM_SAFETY_COLS} FROM items WHERE id IN (${ids.map(() => "?").join(",")})`, ids).map((i) => [i.id, i]));
    const p = input.patientId
        ? d.get("SELECT id, name, sex, weight_kg, height_cm, allergy_status, dob FROM patients WHERE id = ?", [input.patientId]) : undefined;
    const out = [];
    const add = (a) => { if (!out.some((x) => x.key === a.key))
        out.push(a); };
    const allergies = p ? d.all("SELECT id, kind, value, reaction, severity FROM patient_allergies WHERE patient_id = ? AND active = 1", [p.id]) : [];
    const running = p ? runningOrders(d, p.id) : [];
    const changing = new Set([...input.candidates.map((c) => c.orderId).filter((x) => x != null), ...(input.replacing ?? [])]);
    const others = running.filter((o) => !changing.has(o.order_id));
    const rules = d.all("SELECT id, a_kind, a_value, b_kind, b_value, severity, message, advice FROM interaction_rules WHERE active = 1");
    if (p && p.allergy_status === "unknown")
        add({ key: "missing:allergies", kind: "missing", level: "info", itemId: null, itemName: null,
            message: "This patient's allergies are not recorded — ask and record them (or No known allergies) in the patient's details" });
    input.candidates.forEach((c, idx) => {
        const i = items.get(c.itemId);
        if (!i)
            return;
        const name = shownName(i);
        // allergies
        // (the key names the allergy by its text, so a pharmacy PC's copy and the main server agree on it)
        for (const a of allergies)
            if (matches(i, a.kind, a.value))
                add({ key: `allergy:${a.kind}:${norm(a.value)}:${i.id}`, kind: "allergy", level: "critical", itemId: i.id, itemName: name,
                    message: `Allergy: the patient is allergic to ${iso(a.value)}${a.reaction ? ` (${iso(a.reaction)})` : ""} — ${iso(name)} contains it or belongs to it`,
                    advice: a.severity === "severe" ? "Severe allergy recorded: do not give unless the doctor confirms" : null });
        if (allergies.some((a) => a.kind === "ingredient") && !ingredients(i.active_ingredient).length)
            add({ key: `missing:ingredient:${i.id}`, kind: "missing", level: "info", itemId: i.id, itemName: name,
                message: `${iso(name)} has no active ingredient in the catalogue: the patient's ingredient allergies were checked against its name only` });
        // high-alert
        if (i.high_alert)
            add({ key: `high_alert:${i.id}`, kind: "high_alert", level: "warning", itemId: i.id, itemName: name,
                message: `High-alert medicine: ${iso(name)} — check the patient, the dose, the route and the rate again before it goes`,
                advice: settingBool("safety.high_alert_double_check") ? "A second pharmacist checks it too" : null });
        // duplicates
        if (input.duplicates !== false && p && !c.additive) {
            const ais = ingredients(i.active_ingredient);
            const shared = (other) => ingredients(other).find((a) => ais.some((x) => sameIngredient(a, x)));
            for (const o of others) {
                if (o.id === i.id)
                    add({ key: `duplicate:item:${i.id}:${o.order_id}`, kind: "duplicate", level: "warning", itemId: i.id, itemName: name,
                        message: `Duplicate: the patient has another running order for ${iso(name)} — make sure it is not given twice` });
                else {
                    const same = shared(o.active_ingredient);
                    if (same)
                        add({ key: `duplicate:ai:${i.id}:${o.order_id}`, kind: "duplicate", level: "warning", itemId: i.id, itemName: name,
                            message: `Duplicate therapy: ${iso(name)} and the running order ${iso(shownName(o))} both contain ${iso(same)}` });
                }
            }
            // the same item twice in what is being ordered now
            // the same item, or the same ingredient, twice in what is being ordered now
            input.candidates.forEach((c2, j) => {
                if (j <= idx || c2.additive)
                    return;
                if (c2.itemId === i.id)
                    add({ key: `duplicate:new:${i.id}`, kind: "duplicate", level: "warning", itemId: i.id, itemName: name,
                        message: `Duplicate: ${iso(name)} is in this list more than once` });
                else {
                    const i2 = items.get(c2.itemId);
                    const same = i2 && shared(i2.active_ingredient);
                    if (same)
                        add({ key: `duplicate:newai:${[i.id, i2.id].sort().join("+")}`, kind: "duplicate", level: "warning", itemId: i.id, itemName: name,
                            message: `Duplicate therapy: ${iso(name)} and ${iso(shownName(i2))} in this list both contain ${iso(same)}` });
                }
            });
        }
        // dose limits
        const single = doseAmount(i, c);
        const hasLimits = input.doses !== false && !c.additive && i.dose_unit && [i.max_single_dose, i.max_daily_dose, i.max_single_per_kg, i.max_daily_per_kg].some((x) => x != null);
        if (hasLimits) {
            const perDay = c.orderType === "once" || !c.frequencyHours ? 1 : Math.max(1, 24 / c.frequencyHours);
            const daily = single == null ? null : single * perDay;
            const u = i.dose_unit;
            const over = (what, v, max) => add({ key: `dose:${what}:${i.id}:${c.orderId ?? idx}`, kind: "dose", level: "critical",
                itemId: i.id, itemName: name, message: `Dose: ${iso(name)} ${what} ${fmt(v)} ${u} is above the limit of ${fmt(max)} ${u}` });
            if (single == null)
                add({ key: `dose:unknown:${i.id}`, kind: "dose", level: "info", itemId: i.id, itemName: name,
                    message: `${iso(name)} has dose limits, but the dose could not be read in ${u} — write the dose with its unit (for example 500 ${u})` });
            else {
                if (i.max_single_dose != null && single > i.max_single_dose + 1e-9)
                    over("per dose", single, i.max_single_dose);
                if (i.max_daily_dose != null && daily > i.max_daily_dose + 1e-9)
                    over("per day", daily, i.max_daily_dose);
                const kg = p?.weight_kg;
                if ((i.max_single_per_kg != null || i.max_daily_per_kg != null)) {
                    if (!kg)
                        add({ key: `missing:weight:${i.id}`, kind: "missing", level: "info", itemId: i.id, itemName: name,
                            message: `${iso(name)} has a per-kg dose limit, but the patient's weight is not recorded — record it to check the dose` });
                    else {
                        if (i.max_single_per_kg != null && single > i.max_single_per_kg * kg + 1e-9)
                            over(`per dose (${fmt(single / kg)} ${u}/kg)`, single, i.max_single_per_kg * kg);
                        if (i.max_daily_per_kg != null && daily > i.max_daily_per_kg * kg + 1e-9)
                            over(`per day (${fmt(daily / kg)} ${u}/kg)`, daily, i.max_daily_per_kg * kg);
                    }
                }
            }
        }
        // interactions: with the running orders and with the other medicines of this list
        const partners = [
            ...others.map((o) => ({ item: o, ref: `o${o.order_id}` })),
            ...input.candidates.slice(idx + 1).map((c2) => items.get(c2.itemId)).filter((x) => !!x).map((x) => ({ item: x, ref: `n${x.id}` })),
        ];
        for (const r of rules)
            for (const pt of partners) {
                if (pt.item.id === i.id)
                    continue;
                const hit = (matches(i, r.a_kind, r.a_value) && matches(pt.item, r.b_kind, r.b_value)) || (matches(i, r.b_kind, r.b_value) && matches(pt.item, r.a_kind, r.a_value));
                if (!hit)
                    continue;
                const level = r.severity === "contraindicated" || r.severity === "major" ? "critical" : r.severity === "moderate" ? "warning" : "info";
                const pair = [i.id, pt.item.id].sort().join("+");
                add({ key: `interaction:${r.id}:${pair}`, kind: "interaction", level, itemId: i.id, itemName: name,
                    message: `Interaction (${r.severity}): ${iso(name)} with ${iso(shownName(pt.item))} — ${iso(r.message)}`, advice: r.advice });
            }
    });
    const rank = { critical: 0, warning: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
// ---- confirming and logging
export const zSafetyAck = z.object({
    ack: z.array(z.string().max(200)).max(200).default([]),
    reason: z.string().trim().max(500).nullish().transform((v) => v || null),
    checker: z.object({ username: z.string().trim().max(100), password: z.string().max(200).optional() }).nullish(),
}).nullish();
export function gateSafety(req, d, alerts, ack) {
    const replay = req.ctx.token === "replay";
    const need = alerts.filter((a) => a.level !== "info");
    const highAlert = settingBool("safety.high_alert_double_check") && alerts.some((a) => a.kind === "high_alert");
    if (replay) {
        // The PC's copy may have been older than the main server's (an allergy recorded here after its last copy): what the
        // pharmacist confirmed there is logged as confirmed, anything else as "not seen" for the pharmacy to check.
        const who = ack?.checker?.username ? d.get("SELECT id FROM users WHERE username = ? COLLATE NOCASE", [ack.checker.username])?.id ?? null : null;
        const seen = new Set(ack?.ack ?? []);
        return { alerts: need.filter((a) => seen.has(a.key)), notSeen: need.filter((a) => !seen.has(a.key)), reason: ack?.reason ?? null,
            checkedBy: who != null && who !== req.ctx.userId ? who : null };
    }
    const acked = new Set(ack?.ack ?? []);
    const missing = need.filter((a) => !acked.has(a.key));
    const needReason = need.some((a) => a.level === "critical");
    if (missing.length || (needReason && !ack?.reason)) {
        throw new HttpError(409, missing.length ? "Check the safety alerts before going ahead" : "Give the reason for going ahead despite the critical alerts", { code: "safety_alerts", alerts, needReason, needChecker: highAlert });
    }
    let checkedBy = null;
    if (highAlert) {
        const c = ack?.checker;
        if (!c?.username || !c.password)
            throw new HttpError(409, "A second pharmacist checks this high-alert medicine: enter their username and password", { code: "safety_alerts", alerts, needReason, needChecker: true });
        const u = d.get("SELECT id, username, password_hash, role, role_id, active FROM users WHERE username = ? COLLATE NOCASE", [c.username]);
        // the same guessing limit as signing in (a wrong second-pharmacist password is a wrong sign-in password)
        let ok;
        try {
            ok = throttledCheck("login", req.ip, c.username, () => checkUserPassword(c.password, u?.active ? u.password_hash : null));
        }
        catch (e) {
            if (e instanceof HttpError && e.status === 429)
                throw new HttpError(409, e.message, { code: "safety_alerts", alerts, needReason, needChecker: true, checkerError: true });
            throw e;
        }
        if (!ok || !u)
            throw new HttpError(409, "The second pharmacist's username or password is wrong", { code: "safety_alerts", alerts, needReason, needChecker: true, checkerError: true });
        if (u.id === req.ctx.userId)
            throw new HttpError(409, "The second check must be done by another pharmacist", { code: "safety_alerts", alerts, needReason, needChecker: true, checkerError: true });
        const perms = accessOf(u).perms;
        if (!perms.has("dispense") && !perms.has("orders"))
            throw new HttpError(409, "The second pharmacist's role does not include dispensing or orders", { code: "safety_alerts", alerts, needReason, needChecker: true, checkerError: true });
        checkedBy = u.id;
    }
    return { alerts: need, reason: ack?.reason ?? null, checkedBy };
}
/** Writes the confirmed alerts to the safety alert log. */
export function logSafety(req, d, g, r, action = "overridden") {
    for (const [a, act] of [...r.alerts.map((x) => [x, action]), ...(r.notSeen ?? []).map((x) => [x, "not_seen"])])
        d.run(`INSERT INTO safety_alerts(at, user_id, location_id, patient_id, item_id, kind, level, message, context, action, reason, checked_by, ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [nowIso(), req.ctx.userId, req.ctx.locationId, g.patientId ?? null, a.itemId, a.kind, a.level, a.message, g.context, act, act === "not_seen" ? null : r.reason, r.checkedBy, g.ref ?? null]);
}
/** gateSafety + logSafety around `work` (which runs only when allowed); the info alerts come back for the screen. */
export function withSafety(req, d, g, alerts, ack, work) {
    const r = gateSafety(req, d, alerts, ack);
    const out = work(r.checkedBy);
    if (r.alerts.length || r.notSeen?.length)
        logSafety(req, d, { ...g, ref: out?.ref ?? g.ref }, r);
    const shown = alerts.filter((a) => a.level === "info");
    return shown.length ? { ...out, safety: shown } : out;
}
/** Runs `add` (which creates a patient's orders) and records the second pharmacist on the high-alert orders it made. */
export function markChecked(d, patientId, checkedBy, add) {
    const before = d.get("SELECT MAX(id) m FROM medication_orders WHERE patient_id = ?", [patientId])?.m ?? 0;
    const r = add();
    if (checkedBy)
        d.run(`UPDATE medication_orders SET double_checked_by = ? WHERE patient_id = ? AND id > ?
                        AND item_id IN (SELECT id FROM items WHERE high_alert = 1)`, [checkedBy, patientId, before]);
    return r;
}
/**
 * The body a pharmacy PC queues for later replay: the second pharmacist's password is never stored (it was checked
 * here; the main server does not check replayed work again, it records the username).
 */
export function scrubSafetyBody(body) {
    if (!body.includes("\"checker\""))
        return body;
    try {
        const j = JSON.parse(body);
        const c = j?.safety?.checker;
        if (!c || typeof c !== "object")
            return body;
        delete c.password;
        return JSON.stringify(j);
    }
    catch {
        return body;
    }
}
