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
/** Per-parse error map. zod uses it only for issues without a schema-level message: zod's default text, marked. */
const markDefault = (iss) => {
    const m = z.config().localeError?.(iss);
    const text = typeof m === "string" ? m : m?.message;
    return text == null ? undefined : DEFAULT_MARK + text;
};
/** Validate body/query with zod; throws 400 with field errors. */
export function parse(schema, value) {
    const r = schema.safeParse(value, { error: markDefault });
    if (!r.success) {
        const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, mine: !i.message.startsWith(DEFAULT_MARK) }));
        // Show the user what to fix: the first field message we wrote ourselves (zod's defaults are technical).
        const first = issues.find((d) => d.mine)?.message;
        const details = issues.map((d) => ({ path: d.path, message: d.mine ? d.message : d.message.slice(DEFAULT_MARK.length) }));
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
