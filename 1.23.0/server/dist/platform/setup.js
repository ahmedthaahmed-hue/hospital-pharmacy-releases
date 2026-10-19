// First-run setup: make this PC the main server, or connect it to one as a pharmacy.
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { db, adoptDatabase, keyFileFor } from "../db/index.js";
import { hashPassword } from "../auth/passwords.js";
import { nowIso } from "../lib/time.js";
import { HttpError } from "../lib/http.js";
import { nodeConfig, updateNodeConfig } from "./node-config.js";
import { dataPath, dbFile } from "./paths.js";
import { saveKey } from "./keys.js";
import { appVersion } from "./version.js";
import { hubFetch } from "./pharmacy-agent.js";
import { builtinRoleId } from "../auth/access.js";
import { reserveOfflineIds } from "./ids.js";
/** Make this the main hospital server. If it has no users yet, create the first admin: the system's owner. */
export function setupServer(b) {
    const hasUsers = !!db().get("SELECT 1 FROM users LIMIT 1");
    if (!hasUsers) {
        const u = (b.adminUsername ?? "").trim() || "admin", pw = b.adminPassword ?? "";
        if (pw.length < 6)
            throw new HttpError(400, "Set an admin password of at least 6 characters");
        db().run("INSERT INTO users(username, display_name, password_hash, role, role_id, must_change_password, created_at) VALUES (?,?,?,?,?,0,?)", [u, "Owner", hashPassword(pw), "admin", builtinRoleId("owner"), nowIso()]);
    }
    updateNodeConfig({ role: "server", name: (b.name ?? nodeConfig().name).trim(), setupAt: nowIso() });
    return { role: "server", name: nodeConfig().name, createdAdmin: !hasUsers };
}
/** hubFetch for the setup screen: the main server's refusal (wrong password…) or "cannot reach it", as a clear message. */
async function askServer(serverUrl, path, o) {
    try {
        return await hubFetch(serverUrl, path, o);
    }
    catch (e) {
        if (typeof e?.status === "number" && e.status < 500)
            throw new HttpError(e.status === 409 ? 409 : 400, `The main server says: ${e.message}`);
        throw new HttpError(502, `Cannot reach the main server at ${serverUrl}. Check the address and that the main server is running.`);
    }
}
/** The certificate the server at this address shows (not checked: there is nothing yet to check it against), or null. */
export function peerCertificate(serverUrl, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(serverUrl);
        }
        catch {
            return resolve(null);
        }
        const done = (pem) => { clearTimeout(timer); sock.destroy(); resolve(pem); };
        const sock = tlsConnect({ host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), rejectUnauthorized: false,
            servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname, ALPNProtocols: ["http/1.1"] }, () => {
            const raw = sock.getPeerCertificate()?.raw;
            done(raw ? `-----BEGIN CERTIFICATE-----\n${raw.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n` : null);
        });
        sock.on("error", () => done(null));
        const timer = setTimeout(() => done(null), timeoutMs);
    });
}
/** Register with the main server and pull the first database copy. */
export async function connectAsPharmacy(b) {
    if (!b.serverUrl)
        throw new HttpError(400, "Enter the main server address, e.g. http://192.168.1.2:8080");
    // First contact over TLS, trusting the certificate the main server shows now (so the admin's password does not
    // cross the network in the clear); at its first sync this PC gets the certificate again, vouched for with its sync
    // key (platform/tls.ts). A main server from before HTTPS: plain HTTP. A certificate pinned before is replaced.
    const base = b.serverUrl.replace(/\/+$/, "");
    const cert = await peerCertificate(base.replace(/^http:/i, "https:"));
    const serverUrl = cert ? base.replace(/^http:/i, "https:") : base.replace(/^https:/i, "http:");
    updateNodeConfig({ serverCert: cert ?? undefined });
    const name = (b.name ?? nodeConfig().name).trim();
    const nodeUuid = nodeConfig().nodeUuid;
    if (!b.adminUsername || !b.adminPassword)
        throw new HttpError(400, "Enter an admin username and password of the main server");
    // Step 1: check the server and list its pharmacies.
    const list = await askServer(serverUrl, "/api/sync/register", { method: "POST",
        body: { username: b.adminUsername, password: b.adminPassword, nodeUuid, name } });
    if (!b.locationId)
        return { step: "choose-location", serverName: list.serverName, serverVersion: list.version, locations: list.locations,
            needsCode: !!list.needsCode };
    if (list.version && list.version !== appVersion())
        throw new HttpError(409, `The main server runs version ${list.version} and this PC runs ${appVersion()}. Update this PC first.`);
    // Step 2: register for the chosen pharmacy.
    const reg = await askServer(serverUrl, "/api/sync/register", { method: "POST",
        body: { username: b.adminUsername, password: b.adminPassword, nodeUuid, name, locationId: b.locationId, ...(b.code ? { code: b.code } : {}) } });
    // Pull the first encrypted copy of the database, keyed with our sync key, and make it this PC's database. (Which
    // version of the data it is, so the first sync does not download the same copy again.)
    const state = await askServer(serverUrl, "/api/sync/state", { method: "GET", token: reg.nodeToken });
    // (a whole database: give it time — a hospital's copy is far bigger than the demo's, which alone takes seconds)
    const buf = await askServer(serverUrl, "/api/sync/snapshot", { method: "GET", raw: true, token: reg.nodeToken, timeoutMs: 10 * 60_000 });
    const tmp = dataPath(`first-snapshot-${randomUUID()}.tmp`);
    writeFileSync(tmp, Buffer.from(buf));
    try {
        // The snapshot is encrypted with the sync key; adopt it, and keep that key as this PC's database key.
        adoptDatabase(tmp, reg.syncKey, (hex) => saveKey(keyFileFor(dbFile()), hex));
    }
    finally {
        rmSync(tmp, { force: true });
    }
    reserveOfflineIds(db(), reg.nodeId);
    db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('snapshot_revision', ?)", [`${state.bootId}:${state.revision}`]);
    // The sync key is now this PC's database key, kept (sealed) in db.key only: writing it into node.json as well would
    // leave the key in plain text next to the database it opens.
    updateNodeConfig({ role: "pharmacy", name, serverUrl, locationId: b.locationId, nodeId: reg.nodeId,
        nodeToken: reg.nodeToken, setupAt: nowIso() });
    return { role: "pharmacy", name, serverName: reg.serverName, locationId: b.locationId };
}
