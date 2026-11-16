import { allocateItemNo } from "./routes.js";
import { STANDARD_ITEMS } from "./standard-items.data.js";
/** Names compared as people write them: hamza forms, ta marbuta, alef maqsura, spaces, 2/0 and 2-0. */
export function sameName(s) {
    return (s ?? "").replace(/ی/g, "ي").replace(/ک/g, "ك").replace(/[ً-ْـ'"*()؛☼]/g, "")
        .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
        .replace(/\//g, "-").replace(/\s+/g, "").toLowerCase();
}
/** The catalogue's names, for "is it there already". */
export function catalogueNames(d) {
    const names = new Map();
    for (const i of d.all("SELECT id, name, selection_name FROM items")) {
        names.set(sameName(i.name), i.id);
        if (i.selection_name)
            names.set(sameName(i.selection_name), i.id);
    }
    return names;
}
export function standardItemsSummary(d) {
    const have = catalogueNames(d);
    const missing = STANDARD_ITEMS.filter((i) => !have.has(sameName(i.name)));
    return { total: STANDARD_ITEMS.length, missing: missing.length, list: missing.map((i) => ({ name: i.name, form: i.form ?? null })) };
}
/** Adds the list's items the catalogue lacks. Run inside a transaction. Returns the names added. */
export function addStandardItems(d) {
    const have = catalogueNames(d);
    const added = [];
    for (const i of STANDARD_ITEMS) {
        if (have.has(sameName(i.name)))
            continue;
        const { itemNo, id } = allocateItemNo();
        d.run("INSERT INTO items(id,item_no,name,selection_name,strength,strength_unit,form,unit,active) VALUES (?,?,?,?,?,?,?,?,1)", [id, itemNo, i.name, i.name, i.strength ?? null, i.strengthUnit ?? null, i.form ?? null, i.unit ?? null]);
        have.set(sameName(i.name), id);
        added.push(i.name);
    }
    return added;
}
/* ---------------- (1.53) filling an item's details from a similar one ---------------- */
const FORM_KINDS = [
    ["cream", /كريم|مرهم|(^|\s)جل(\s|$)/], ["drops", /نقط|قطر[هة]/], ["spray", /اسبراي|بخاخ/], ["suppository", /لبوس/],
    ["syrup", /شراب/], ["effervescent", /فوار/], ["injection", /امبول|أمبول|فيال|حقن|وريد/], ["tablet", /اقراص|أقراص|قرص|كبسول/],
    ["infusion", /محلول/], ["supply", /مستلزمات|خيوط/], ["patch", /لصق|باتش/],
];
/** The kind of medicine a form or a name says (tablet, injection, syrup…), or null when it does not say. */
export function formKind(text) {
    const t = text ?? "";
    return FORM_KINDS.find(([, re]) => re.test(t))?.[0] ?? null;
}
/** The drug's name without its strength, pack or form: "اتور 10مجم 7 قرص" and "اتور" are the same drug. */
export function baseName(name) {
    return sameName((name ?? "")
        .replace(/\d+(?:[.,]\d+)?\s*(مجم|ملجم|مج|جم|مكجم|مل|سم|وحده|وحدة|وحدات|%)?/g, " ")
        .replace(/(^|\s)(قرص|ق|كيس|باتش|اقراص|أقراص|امبول|أمبول|فيال|شراب|كريم|مرهم|جل|نقط|قطرة|قطره|اسبراي|بخاخ|بخاخة|لبوس|حقن|فوار|كبسولات|كبسولة|الاصلي|الاصلى|الأصلي)(?=\s|$)/g, " "));
}
const FILLABLE = ["activeIngredient", "class", "form", "unit", "type", "strengthUnit"];
const COL = { activeIngredient: "active_ingredient", class: "class", form: "form", unit: "unit", type: "type", strengthUnit: "strength_unit" };
const empty = (v) => v == null || String(v).trim() === "";
/**
 * The catalogue's item that is the same drug in another strength or pack (the same name once strength, pack and form
 * are left out), and the details it can give: only those this item lacks. When the two are not the same kind (tablets
 * and an injection, a syrup and tablets), only the active ingredient is taken: the form, the unit and the class (which
 * here follows the form) would be wrong.
 */
export function similarFill(row, catalogue) {
    const base = baseName(row.name);
    if (base.length < 3)
        return null;
    const rowKind = formKind(row.form) ?? formKind(row.name);
    const cands = catalogue.filter((c) => c.id !== row.id && baseName(c.name) === base && (!empty(c.activeIngredient) || !empty(c.class)));
    if (!cands.length)
        return null;
    const sameKind = (c) => { const k = formKind(c.form) ?? formKind(c.name); return !rowKind || !k || k === rowKind; };
    const best = cands.find(sameKind) ?? cands[0];
    const whole = sameKind(best);
    const fill = {};
    for (const f of FILLABLE) {
        if (!whole && f !== "activeIngredient")
            continue;
        if (empty(row[f]) && !empty(best[f]))
            fill[f] = String(best[f]).trim();
    }
    return Object.keys(fill).length ? { from: { id: best.id, name: best.name }, fill } : null;
}
/** Fills every listed item's empty details from its similar item. Run inside a transaction. Returns how many changed. */
export function fillFromSimilar(d, ids) {
    const cols = `i.id, i.name, i.selection_name AS "selectionName", i.active_ingredient AS "activeIngredient", i.class, i.form, i.unit, i.type, i.strength_unit AS "strengthUnit"`;
    const catalogue = d.all(`SELECT ${cols} FROM items i WHERE i.active = 1`);
    // the items missing a detail (as Items → Complete details lists them), or those named
    const missing = (c) => empty(c.form) || empty(c.unit) || empty(c.class) || (empty(c.activeIngredient) && !["مستلزمات", "خيوط"].includes(c.form ?? ""));
    const targets = catalogue.filter((c) => (ids ? ids.includes(c.id) : true) && missing(c));
    const out = [];
    for (const r of targets) {
        const s = similarFill(r, catalogue);
        if (!s)
            continue;
        const keys = Object.keys(s.fill);
        d.run(`UPDATE items SET ${keys.map((k) => `${COL[k]} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => s.fill[k]), r.id]);
        Object.assign(r, s.fill);
        out.push({ id: r.id, name: r.name, from: s.from.name, fields: keys });
    }
    return { changed: out.length, items: out };
}
