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
