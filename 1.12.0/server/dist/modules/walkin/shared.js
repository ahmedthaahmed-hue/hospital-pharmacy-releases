// Helpers shared by the walk-in, Rx-template, order-template and operations modules (slice D).
import { z } from "zod";
import { bad } from "../../lib/http.js";
/** Item fields used to pre-fill a walk-in / Rx line: unit, default route, concentration (strength, else default dose). */
export function itemDefaults(db, itemId) {
    const i = db.get("SELECT id, COALESCE(selection_name, name) AS name, unit, default_route, strength, default_dose, active FROM items WHERE id = ?", [itemId]);
    if (!i)
        throw bad("Item not found in the items list");
    const blank = (v) => v == null || String(v).trim() === "";
    return {
        id: i.id, name: i.name, unit: blank(i.unit) ? null : i.unit, route: blank(i.default_route) ? null : i.default_route,
        conc: !blank(i.strength) ? i.strength : blank(i.default_dose) ? null : i.default_dose, active: i.active,
    };
}
export const isBlank = (v) => v == null || String(v).trim() === "";
/** Positive decimal quantity (legacy forced integers). */
export const zQty = z.coerce.number().positive("Quantity must be greater than zero").max(1_000_000);
export const zText = (max = 500) => z.string().trim().max(max).nullish().transform((v) => (v === "" || v == null ? null : v));
export const zItemId = z.string().trim().min(1, "Choose the item").max(40);
/** Item display name for API rows. */
export const ITEM_NAME = "COALESCE(i.selection_name, i.name)";
