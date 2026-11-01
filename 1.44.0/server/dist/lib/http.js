import { z } from "zod";
import { db } from "../db/index.js";
import { nowIso } from "./time.js";
/** Error with an HTTP status and a user-facing (English) message. */
export class HttpError extends Error {
    status;
    details;
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
export const notFound = (what = "Record") => new HttpError(404, `${what} not found`);
export const bad = (msg, details) => new HttpError(400, msg, details);
/** Prefix that marks zod's own default messages, as opposed to the messages written on our schemas. */
const DEFAULT_MARK = "\u0001";
/**
 * Per-parse error map. zod uses it only for issues without a schema-level message. It used to pass zod's own text on
 * ("Too small: expected number to be >0") and the answer said only "Invalid data"; since 1.43 it says, in plain words,
 * which field and what is wrong with it (Slop Patterns A220, schema-speak errors), marked as a default.
 */
const markDefault = (iss) => DEFAULT_MARK + plainIssue(iss);
/** Names of the fields our forms send, as a pharmacist knows them; other keys are spelled out ("qtyPerDose" → "Qty per dose"). */
const FIELD = {
    qty: "Quantity", itemId: "Item", patientId: "Patient", locationId: "Pharmacy", fromLocationId: "Sending pharmacy",
    toLocationId: "Receiving pharmacy", expiry: "Expiry date", batchNo: "Batch number", qtyPerDose: "Quantity per dose",
    frequencyHours: "Frequency", firstDoseTime: "First dose time", startDate: "Start date", durationDays: "Duration (days)",
    id: "ID", lineId: "Line", lines: "Lines", username: "Username", password: "Password", name: "Name", note: "Note",
    notes: "Notes", date: "Date", from: "From", to: "To", dose: "Dose", route: "Route", unit: "Unit", price: "Price",
    unitPrice: "Unit price", counted: "Counted quantity", expected: "Expected quantity", min: "Minimum", max: "Maximum",
};
/** "lines.1.qty" → "Line 2: Quantity"; nothing → "The value". */
export function fieldName(path) {
    const parts = [];
    for (let i = 0; i < path.length; i++) {
        const k = path[i];
        if (typeof k === "number")
            continue;
        const key = String(k);
        const next = path[i + 1];
        const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
        const label = FIELD[key] ?? words.charAt(0).toUpperCase() + words.slice(1);
        parts.push(typeof next === "number" ? `${label.replace(/s$/, "")} ${next + 1}` : label);
    }
    return parts.length ? parts.join(": ") : "The value";
}
/** One issue in plain words: "Quantity must be more than 0", "Name is required", "Note is too long (at most 500 characters)". */
export function plainIssue(i) {
    const f = fieldName(i.path ?? []);
    const n = (v) => Number(v);
    switch (i.code) {
        case "invalid_type":
            if (i.input === undefined || i.input === null)
                return `${f} is required`;
            return i.expected === "number" || i.expected === "int" ? `${f} must be a number`
                : i.expected === "string" ? `${f} must be text` : i.expected === "array" ? `${f} must be a list` : `${f} is not valid`;
        case "too_small":
            if (i.origin === "string")
                return n(i.minimum) <= 1 ? `${f} is required` : `${f} must be at least ${n(i.minimum)} characters`;
            if (i.origin === "array" || i.origin === "set")
                return n(i.minimum) <= 1 ? `${f}: add at least one` : `${f}: add at least ${n(i.minimum)}`;
            return i.inclusive ? `${f} must be at least ${n(i.minimum)}` : `${f} must be more than ${n(i.minimum)}`;
        case "too_big":
            if (i.origin === "string")
                return `${f} is too long (at most ${n(i.maximum)} characters)`;
            if (i.origin === "array" || i.origin === "set")
                return `${f}: at most ${n(i.maximum)}`;
            return i.inclusive ? `${f} must be at most ${n(i.maximum)}` : `${f} must be less than ${n(i.maximum)}`;
        case "invalid_format": return i.format === "email" ? `${f} is not an email address` : `${f} is not in the right format`;
        case "invalid_value": return i.values?.length && i.values.length <= 8 ? `${f} must be one of: ${i.values.join(", ")}` : `${f} is not one of the choices`;
        case "not_multiple_of": return `${f} is not a whole step`;
        case "unrecognized_keys": return `${f} has fields it does not take`;
        default: return `${f} is not valid`;
    }
}
/** Validate body/query with zod; throws 400 with field errors. */
export function parse(schema, value) {
    const r = schema.safeParse(value, { error: markDefault });
    if (!r.success) {
        const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, mine: !i.message.startsWith(DEFAULT_MARK) }));
        const details = issues.map((d) => ({ path: d.path, message: d.mine ? d.message : d.message.slice(DEFAULT_MARK.length) }));
        // Show the user what to fix: the first message we wrote ourselves, else the first in plain words (1.43; was "Invalid data").
        const first = issues.find((d) => d.mine)?.message ?? details[0]?.message;
        throw new HttpError(400, first ?? "Invalid data", details);
    }
    return r.data;
}
/** Permission gates (core/permissions.ts): the user's role must give `perm`. */
export const can = (ctx, perm) => ctx.perms.has(perm);
export function requirePerm(req, perm) {
    if (!req.ctx.perms.has(perm))
        throw new HttpError(403, PERM_DENIED[perm] ?? "Your role does not allow this");
}
/** Only the owner (roles, the licence, system notifications). */
export function requireOwner(req) {
    if (!req.ctx.owner)
        throw new HttpError(403, "Only the system's owner can do this");
}
const PERM_DENIED = {
    dispense: "Your role does not allow dispensing", runs: "Your role does not allow the daily run", orders: "Your role does not allow changing orders",
    walkin: "Your role does not allow walk-in prescriptions", patients: "Your role does not allow changing patients",
    "stock.receive": "Your role does not allow receiving stock", "stock.adjust": "Your role does not allow stock counts and adjustments",
    "stock.transfer": "Your role does not allow stock transfers between pharmacies", "stock.purchase": "Your role does not allow purchasing (suppliers, purchase orders)",
    items: "Your role does not allow changing the item catalogue", templates: "Your role does not allow changing templates",
    operations: "Your role does not allow changing operations", reports: "Your role does not include reports",
    analytics: "Your role does not include analytics",
    "orders.verify": "Your role does not allow verifying orders",
    records: "Your role does not allow keeping the records", "records.setup": "Your role does not allow setting up the records",
};
/** Append to the audit log (who did what). */
export function audit(req, action, entity, entityId, details) {
    db().run("INSERT INTO audit_log(at,user_id,location_id,action,entity,entity_id,details) VALUES (?,?,?,?,?,?,?)", [
        nowIso(), req?.ctx?.userId ?? null, req?.ctx?.locationId ?? null, action, entity ?? null,
        entityId == null ? null : String(entityId), details === undefined ? null : JSON.stringify(details),
    ]);
}
// Common zod helpers
export const zId = z.coerce.number().int().positive();
/** YYYY-MM-DD that is a real calendar date (2026-02-30 is rejected). */
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}, "Invalid date");
export const zTime = z.string().regex(/^\d{1,2}:\d{2}$/, "Invalid time");
export const zDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Invalid date/time");
export const zBool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
export const zOptStr = z.string().trim().max(2000).nullish().transform((v) => (v === "" || v == null ? null : v));
