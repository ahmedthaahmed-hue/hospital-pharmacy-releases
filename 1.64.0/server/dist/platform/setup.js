// First-run setup: make this PC the main server, or connect it to one as a pharmacy.
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { db, adoptDatabase, keyFileFor } from "../db/index.js";
import { hashPassword } from "../auth/passwords.js";
import { nowIso } from "../lib/time.js";
import { HttpError } from "../lib/http.js";
import { nodeConfig, updateNodeConfig, saveNodeConfig } from "./node-config.js";
import { dataPath, dbFile } from "./paths.js";
import { saveKey } from "./keys.js";
import { appVersion, compareVersions } from "./version.js";
import { hubFetch } from "./pharmacy-agent.js";
import { RESTART_DELAY_MS, stageServerVersion } from "./updater.js";
import { beginUpdate, updateFailed } from "./update-progress.js";
import { builtinRoleId } from "../auth/access.js";
import { reserveOfflineIds } from "./ids.js";
import { certCode, peerCertificate } from "./tls.js";
export { peerCertificate };
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
/** Register with the main server and pull the first database copy. */
/** The main server's security code as this PC sees it now, before any password is sent (null: it has no HTTPS). */
export async function peerCode(serverUrl) {
    const cert = await peerCertificate(serverUrl.replace(/\/+$/, "").replace(/^http:/i, "https:"));
    return { code: cert ? certCode(cert) : null, https: !!cert };
}
let matching = false;
/**
 * (1.57) A PC being set up installs its main server's (newer) version before it joins: the package comes from the main
 * server (no internet needed), the owner's signature and every file are checked here, and the launcher restarts into
 * it. The screens show the update's bar meanwhile; setup starts again in the new version.
 */
async function matchServerVersion(serverUrl, ticket, version) {
    if (matching)
        return;
    matching = true;
    beginUpdate(version, { auto: true, source: "main server" });
    try {
        // (1.64) from the main server or, for what it cannot give, from this PC's own internet (updater.ts stageServerVersion)
        await stageServerVersion(version, {
            release: () => hubFetch(serverUrl, "/api/sync/release", { method: "GET", ticket, timeoutMs: 60_000 }),
            file: async (path) => Buffer.from(await hubFetch(serverUrl, `/api/sync/release/file?path=${encodeURIComponent(path)}`, { method: "GET", raw: true, ticket, timeoutMs: 120_000 })),
        });
        setTimeout(() => process.exit(69), RESTART_DELAY_MS); // the launcher swaps the new files in and starts again
    }
    catch (e) {
        matching = false;
        updateFailed(String(e?.message ?? e));
    }
}
export async function connectAsPharmacy(b) {
    if (!b.serverUrl)
        throw new HttpError(400, "Enter the main server address, e.g. http://192.168.1.2:8080");
    // First contact over TLS, trusting the certificate the main server shows now (so the admin's password does not
    // cross the network in the clear); at its first sync this PC gets the certificate again, vouched for with its sync
    // key (platform/tls.ts). A main server from before HTTPS: plain HTTP. A certificate pinned before is replaced.
    const base = b.serverUrl.replace(/\/+$/, "");
    const cert = await peerCertificate(base.replace(/^http:/i, "https:"));
    const serverUrl = cert ? base.replace(/^http:/i, "https:") : base.replace(/^https:/i, "http:");
    // The code the admin compared with the main server's (1.32): another certificate now means someone else answers.
    if (b.certCode && (!cert || certCode(cert) !== b.certCode.replace(/\s+/g, " ").trim().toUpperCase()))
        throw new HttpError(409, "The main server's security code is not the one you checked. Do not go on: someone may be answering in its place. Check the address and the code on the main server (Admin → Network).", { code: "cert_changed" });
    updateNodeConfig({ serverCert: cert ?? undefined });
    const name = (b.name ?? nodeConfig().name).trim();
    const nodeUuid = nodeConfig().nodeUuid;
    if (!b.adminUsername || !b.adminPassword)
        throw new HttpError(400, "Enter an admin username and password of the main server");
    // Step 1: check the server and list its pharmacies.
    const list = await askServer(serverUrl, "/api/sync/register", { method: "POST",
        body: { username: b.adminUsername, password: b.adminPassword, nodeUuid, name, version: appVersion() } });
    // (1.57) The two must run the same version before this PC joins, and this PC sees to it by itself.
    if (list.version && list.version !== appVersion()) {
        if (compareVersions(list.version, appVersion()) > 0) {
            // the main server is newer: this PC installs the main server's version from it now, then restarts into it
            if (!list.setupTicket)
                throw new HttpError(409, `The main server runs version ${list.version} and this PC runs ${appVersion()}. Run this PC's newer installer, then connect again.`);
            if (process.env.HPS_LAUNCHER !== "1")
                throw new HttpError(409, `The main server runs version ${list.version} and this PC runs ${appVersion()}. This PC can only update itself when started by its launcher (the Desktop shortcut or the Windows service).`);
            void matchServerVersion(serverUrl, list.setupTicket, list.version);
            return { step: "updating", serverName: list.serverName, serverVersion: list.version, version: appVersion() };
        }
        // the main server is older, and a PC never goes back a version: the main server was asked to update itself
        throw new HttpError(409, `The main server runs an older version (${list.version}) than this PC (${appVersion()}). It has been asked to update itself, which it does when nobody is working on it (it needs the internet). Try again in a few minutes.`, { code: "server_older" });
    }
    if (!b.locationId)
        return { step: "choose-location", serverName: list.serverName, serverVersion: list.version, locations: list.locations,
            needsCode: !!list.needsCode };
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
    // What node.json holds so far (the certificate pinned at first contact) is sealed with the old key: seal it again
    // with this one at once, so a stop before setup ends does not leave it unreadable (platform/node-config.ts).
    saveNodeConfig(nodeConfig());
    reserveOfflineIds(db(), reg.nodeId);
    db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('snapshot_revision', ?)", [`${state.bootId}:${state.revision}`]);
    // The sync key is now this PC's database key, kept (sealed) in db.key only: writing it into node.json as well would
    // leave the key in plain text next to the database it opens.
    // (1.64) the main server's id, to find it again by itself if its address changes (over the pinned link: its own word)
    const serverNodeUuid = await hubFetch(serverUrl, "/api/system/info", { method: "GET", timeoutMs: 8000 })
        .then((i) => typeof i?.nodeUuid === "string" ? i.nodeUuid : undefined, () => undefined);
    updateNodeConfig({ role: "pharmacy", name, serverUrl, serverNodeUuid, locationId: b.locationId, nodeId: reg.nodeId,
        nodeToken: reg.nodeToken, setupAt: nowIso() });
    return { role: "pharmacy", name, serverName: reg.serverName, locationId: b.locationId };
}
