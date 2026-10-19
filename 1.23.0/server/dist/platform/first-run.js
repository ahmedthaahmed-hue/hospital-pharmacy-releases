// What the first-run screens need beyond choosing a role:
//   - the data a new main server starts with: the old Access database, the demo data, or nothing (one pharmacy);
//   - finding the main server on the local network, so a pharmacy PC does not need its address typed in;
//   - this PC's addresses, so the main server can show what the pharmacy PCs connect to;
//   - the role the installer was built for (Main server / Pharmacy PC installers), so the screen can skip that question.
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { HttpError } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { importLegacy, sourceFromAccdb, sourceFromMirror } from "../db/import-legacy.js";
import { prepareDemo, DEMO_PASSWORD, DEMO_USERS } from "../db/demo.js";
import { appRoot } from "./paths.js";
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
    db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "setup.first_data", "system", JSON.stringify({ kind: d.kind, counts, demo })]);
    return { kind: d.kind, counts, ...(demo && { demoUsers: DEMO_USERS.map((u) => ({ username: u.username, role: u.role })), demoPassword: DEMO_PASSWORD }) };
}
/**
 * Look for main servers on this PC's local networks: every address of each /24 this PC is on, on the main server port
 * (8080; HPS_SERVER_PORT overrides).
 * A main server answers /api/system/info with role "server". Takes a few seconds.
 */
export async function discoverServers(port = Number(process.env.HPS_SERVER_PORT ?? 8080), timeoutMs = 700) {
    const mine = new Set(lanAddresses());
    const hosts = [];
    for (const ip of mine) {
        const base = ip.split(".").slice(0, 3).join(".");
        for (let i = 1; i < 255; i++)
            hosts.push(`${base}.${i}`); // this PC too: it answers "unset" itself, but a main server may run here
    }
    const found = [];
    const probe = async (h) => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
            const r = await fetch(`http://${h}:${port}/api/system/info`, { signal: c.signal });
            if (!r.ok)
                return;
            const j = await r.json();
            if (j?.app === "hospital-pharmacy" && j.role === "server")
                found.push({ url: `http://${h}:${port}`, name: String(j.name ?? h), version: String(j.version ?? "") });
        }
        catch { /* nothing there */ }
        finally {
            clearTimeout(t);
        }
    };
    for (let i = 0; i < hosts.length; i += 128)
        await Promise.all(hosts.slice(i, i + 128).map(probe));
    return found.sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
}
