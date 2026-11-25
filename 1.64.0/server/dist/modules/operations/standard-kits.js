import { allocateItemNo } from "../items/routes.js";
import { sameName } from "../items/standard-items.js";
import { STANDARD_NEW_ITEMS, STANDARD_OPERATIONS } from "./standard-kits.data.js";
export { sameName };
export function standardKitsSummary() {
    return {
        operations: STANDARD_OPERATIONS.length,
        lines: STANDARD_OPERATIONS.reduce((n, o) => n + o.lines.length, 0),
        newItems: STANDARD_NEW_ITEMS.length,
        list: STANDARD_OPERATIONS.map((o) => ({ opNo: o.opNo, name: o.name, group: o.group, lines: o.lines.length })),
    };
}
/** Loads every standard kit into `locationId`. Run inside a transaction. */
export function loadStandardKits(d, locationId, replace) {
    const res = { operationsCreated: 0, kitsFilled: 0, kitsKept: [], itemsCreated: [], lines: 0 };
    const items = d.all("SELECT id, name FROM items");
    const byName = new Map(items.map((i) => [sameName(i.name), i.id]));
    const byId = new Map(items.map((i) => [i.id, i.name]));
    const extra = new Map(STANDARD_NEW_ITEMS.map((n) => [sameName(n.name), n]));
    const itemFor = (l) => {
        if (l.id && sameName(byId.get(l.id)) === sameName(l.name))
            return l.id;
        const found = byName.get(sameName(l.name));
        if (found)
            return found;
        const n = extra.get(sameName(l.name)) ?? { name: l.name, form: "مستلزمات", unit: "وحدة" };
        const { itemNo, id } = allocateItemNo();
        d.run("INSERT INTO items(id,item_no,name,selection_name,active_ingredient,form,unit,active) VALUES (?,?,?,?,?,?,?,1)", [id, itemNo, n.name, n.name, n.generic ?? null, n.form, n.unit]);
        byName.set(sameName(n.name), id);
        byId.set(id, n.name);
        res.itemsCreated.push(n.name);
        return id;
    };
    const ops = d.all("SELECT id, name FROM operations");
    for (const o of STANDARD_OPERATIONS) {
        let opId = ops.find((x) => sameName(x.name) === sameName(o.name))?.id;
        if (!opId) {
            opId = Number(d.run("INSERT INTO operations(op_no, name, location_id, active) VALUES (?,?,?,1)", [o.opNo, o.name, locationId]).lastId);
            ops.push({ id: opId, name: o.name });
            res.operationsCreated++;
        }
        let kit = d.get("SELECT id FROM operation_kits WHERE operation_id = ? AND location_id = ?", [opId, locationId])?.id;
        if (!kit)
            kit = Number(d.run("INSERT INTO operation_kits(operation_id, location_id, active) VALUES (?,?,1)", [opId, locationId]).lastId);
        const has = d.get("SELECT COUNT(*) n FROM operation_kit_lines WHERE kit_id = ?", [kit]).n;
        if (has && !replace) {
            res.kitsKept.push(o.name);
            continue;
        }
        d.run("DELETE FROM operation_kit_lines WHERE kit_id = ?", [kit]);
        for (const l of o.lines) {
            d.run("INSERT INTO operation_kit_lines(kit_id, item_id, default_qty, active) VALUES (?,?,?,1)", [kit, itemFor(l), l.qty]);
            res.lines++;
        }
        d.run("UPDATE operation_kits SET active = 1 WHERE id = ?", [kit]);
        res.kitsFilled++;
    }
    return res;
}
