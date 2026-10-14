// First-run setup: make this PC the main server, or connect it to one as a pharmacy.
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { db, adoptDatabase, keyFileFor } from "../db/index.js";
import { hashPassword } from "../auth/passwords.js";
import { nowIso } from "../lib/time.js";
import { HttpError } from "../lib/http.js";
import { nodeConfig, updateNodeConfig } from "./node-config.js";
import { dataPath, dbFile } from "./paths.js";
import { saveKey } from "./keys.js";
import { appVersion } from "./version.js";
import { hubFetch } from "./pharmacy-agent.js";
import { reserveOfflineIds } from "./ids.js";
/** Make this the main hospital server. If it has no users yet, create the first admin. */
export function setupServer(b) {
    const hasUsers = !!db().get("SELECT 1 FROM users LIMIT 1");
    if (!hasUsers) {
        const u = (b.adminUsername ?? "").trim() || "admin", pw = b.adminPassword ?? "";
        if (pw.length < 6)
            throw new HttpError(400, "Set an admin password of at least 6 characters");
        db().run("INSERT INTO users(username, display_name, password_hash, role, must_change_password, created_at) VALUES (?,?,?,?,0,?)", [u, "Administrator", hashPassword(pw), "admin", nowIso()]);
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
/** Register with the main server and pull the first database copy. */
export async function connectAsPharmacy(b) {
    if (!b.serverUrl)
        throw new HttpError(400, "Enter the main server address, e.g. http://192.168.1.2:8080");
    const serverUrl = b.serverUrl.replace(/\/+$/, "");
    const name = (b.name ?? nodeConfig().name).trim();
    const nodeUuid = nodeConfig().nodeUuid;
    if (!b.adminUsername || !b.adminPassword)
        throw new HttpError(400, "Enter an admin username and password of the main server");
    // Step 1: check the server and list its pharmacies.
    const list = await askServer(serverUrl, "/api/sync/register", { method: "POST",
        body: { username: b.adminUsername, password: b.adminPassword, nodeUuid, name } });
    if (!b.locationId)
        return { step: "choose-location", serverName: list.serverName, serverVersion: list.version, locations: list.locations };
    if (list.version && list.version !== appVersion())
        throw new HttpError(409, `The main server runs version ${list.version} and this PC runs ${appVersion()}. Update this PC first.`);
    // Step 2: register for the chosen pharmacy.
    const reg = await askServer(serverUrl, "/api/sync/register", { method: "POST",
        body: { username: b.adminUsername, password: b.adminPassword, nodeUuid, name, locationId: b.locationId } });
    // Pull the first encrypted copy of the database, keyed with our sync key, and make it this PC's database. (Which
    // version of the data it is, so the first sync does not download the same copy again.)
    const state = await askServer(serverUrl, "/api/sync/state", { method: "GET", token: reg.nodeToken });
    const buf = await askServer(serverUrl, "/api/sync/snapshot", { method: "GET", raw: true, token: reg.nodeToken });
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
