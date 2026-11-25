// What the first-run screens need beyond choosing a role:
//   - the data a new main server starts with: the old Access database, the demo data, or nothing (one pharmacy);
//   - (finding the main server on the local network, so a pharmacy PC does not need its address typed in: discovery.ts)
//   - this PC's addresses, so the main server can show what the pharmacy PCs connect to;
//   - the role the installer was built for (Main server / Pharmacy PC installers), so the screen can skip that question.
import { existsSync, readFileSync } from "node:fs";
import { addStandardItems } from "../modules/items/standard-items.js";
import { loadStandardKits } from "../modules/operations/standard-kits.js";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { HttpError } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { importLegacy, sourceFromAccdb, sourceFromMirror } from "../db/import-legacy.js";
import { prepareDemo, DEMO_PASSWORD, DEMO_USERS } from "../db/demo.js";
import { appRoot } from "./paths.js";
import { nodeConfig } from "./node-config.js";
import { appVersion } from "./version.js";
/** The role the installer was built for ("server" or "pharmacy"), written next to the app by the installer. */
export function presetRole() {
    try {
        const f = join(appRoot(), "install-role.txt");
        if (!existsSync(f))
            return null;
        const v = readFileSync(f, "utf8").trim().toLowerCase();
        return v === "server" || v === "pharmacy" ? v : null;
    }
    catch {
        return null;
    }
}
/** This PC's LAN IPv4 addresses (no loopback, no link-local). */
export function lanAddresses() {
    const out = [];
    for (const list of Object.values(networkInterfaces()))
        for (const n of list ?? [])
            if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254."))
                out.push(n.address);
    return [...new Set(out)];
}
export const appPort = () => Number(process.env.PORT ?? 8080);
/** What a main server tells a pharmacy PC's network search (discovery.ts): what /api/system/info tells anyone, and its port. */
export function discoveryAnswer() {
    const c = nodeConfig();
    return { role: c.role, name: c.name, version: appVersion(), nodeUuid: c.nodeUuid, port: appPort(), addresses: lanAddresses() };
}
/** A database with nothing clinical in it yet (a fresh main server): only then may the first-data step fill it. */
export function isEmptyDatabase() {
    const any = (t) => !!db().get(`SELECT 1 FROM ${t} LIMIT 1`);
    return !any("patients") && !any("dispenses") && !any("walkin_tickets") && !any("batches");
}
/** Fill a fresh main server's database. Users and settings stay as they are. */
export async function loadFirstData(d) {
    if (!isEmptyDatabase())
        throw new HttpError(409, "This server already has data — import the old database from the command line instead (docs/DEPLOY.md)");
    if (d.kind === "empty") {
        const name = d.pharmacy.trim();
        if (!name)
            throw new HttpError(400, "Enter the name of the first pharmacy");
        if (!db().get("SELECT 1 FROM locations LIMIT 1"))
            db().run("INSERT INTO locations(name, active) VALUES (?, 1)", [name]);
        return { kind: "empty", counts: { locations: 1 } };
    }
    let src;
    if (d.kind === "demo") {
        const mirror = join(appRoot(), "db", "pharmacy_demo.sqlite");
        if (!existsSync(mirror))
            throw new HttpError(404, "The demo data is not part of this install");
        src = sourceFromMirror(mirror);
    }
    else {
        try {
            src = await sourceFromAccdb(d.file, d.password);
        }
        catch (e) {
            const m = String(e?.message ?? e);
            throw new HttpError(400, /password|decrypt|encrypt/i.test(m) ? "Could not open the Access database — check its password" : `This is not a readable Access database (${m})`);
        }
        if (!src.tables().includes("Patients"))
            throw new HttpError(400, "This Access database has no patient table — choose the old system's DataBE.accdb (the backend, not the front-end)");
    }
    const lines = [];
    const counts = await importLegacy(db(), src, (l) => lines.push(l));
    // the demo hospital is made current (dates, months of history) and gets staff accounts to try each role
    const demo = d.kind === "demo" ? prepareDemo(db()) : null;
    const standard = d.kind === "accdb" && d.standard ? loadHospitalStandard() : undefined;
    db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "setup.first_data", "system", JSON.stringify({ kind: d.kind, counts, demo, standard })]);
    return { kind: d.kind, counts, ...(standard && { standard }), ...(demo && { demoUsers: DEMO_USERS.map((u) => ({ username: u.username, role: u.role })), demoPassword: DEMO_PASSWORD }) };
}
/**
 * (1.51) The hospital's item list and standard operation kits, on top of the old system's data: the kits go to the
 * pharmacy the old system's operations belong to (its operating theatre pharmacy), else the first one.
 */
export function loadHospitalStandard() {
    const at = db().get(`SELECT l.id FROM locations l JOIN operations o ON o.location_id = l.id WHERE l.active = 1
    GROUP BY l.id ORDER BY COUNT(*) DESC LIMIT 1`)?.id ?? db().get("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1")?.id;
    if (!at)
        return undefined;
    return db().tx(() => {
        const items = addStandardItems(db()).length;
        const k = loadStandardKits(db(), at, false);
        return { items: items + k.itemsCreated.length, kits: k.kitsFilled, kitItems: k.lines, operations: k.operationsCreated, locationId: at };
    });
}
