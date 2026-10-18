import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { openDb, db } from "./db/index.js";
import { dataPath } from "./platform/paths.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/passwords.js";
import { nowIso } from "./lib/time.js";
import { nodeConfig, updateNodeConfig } from "./platform/node-config.js";
import { appVersion } from "./platform/version.js";
import { startRoleServices } from "./platform/services.js";
import { reserveOfflineIds, offlineCounters } from "./platform/ids.js";
import { builtinRoleId } from "./auth/access.js";
import { dualServer, serverCertificate } from "./platform/tls.js";
import { setTlsCert, tlsInfo } from "./platform/tls-state.js";
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0"; // LAN
openDb();
// A database from before networking (it already has users) but no node.json is this hospital's main server.
if (nodeConfig().role === "unset" && db().get("SELECT 1 FROM users LIMIT 1"))
    updateNodeConfig({ role: "server" });
const role = nodeConfig().role;
// A pharmacy PC's sync key is also its database key, which is kept sealed in db.key; an older setup also wrote it in
// plain text into node.json, next to the database it opens. Drop that copy once the database opens without it.
if (role === "pharmacy" && nodeConfig().syncKey && db().key === nodeConfig().syncKey)
    updateNodeConfig({ syncKey: undefined });
// Ids for rows made on a pharmacy PC, one slice per table (platform/ids.ts) — also for a PC set up by an older version,
// which gave every table the same starting id.
const nodeId = nodeConfig().nodeId;
if (role === "pharmacy" && nodeId)
    reserveOfflineIds(db(), nodeId, offlineCounters(db(), nodeId));
// A main server with no setup yet and no users: create the first admin so the server is usable immediately
// (the setup screen can also create it). A pharmacy PC gets its users from the main server's database copy.
if (role === "server" && !db().get("SELECT 1 FROM users LIMIT 1")) {
    // A random first password (not a well-known default anyone on the network could claim first), shown in this
    // console and kept in <data>/first-admin-password.txt until the admin changes it.
    const pw = process.env.ADMIN_PASSWORD ?? randomBytes(9).toString("base64url");
    db().run("INSERT INTO users(username,display_name,password_hash,role,role_id,must_change_password,created_at) VALUES ('admin','Owner',?,'admin',?,1,?)", [hashPassword(pw), builtinRoleId("owner"), nowIso()]);
    if (!process.env.ADMIN_PASSWORD)
        writeFileSync(dataPath("first-admin-password.txt"), `admin\n${pw}\n`, { mode: 0o600 });
    console.log(`Created first admin user 'admin' (password: ${process.env.ADMIN_PASSWORD ? "from ADMIN_PASSWORD" : `${pw} — also in ${dataPath("first-admin-password.txt")}`}). Change it on first login.`);
}
const app = await buildApp({ logger: true });
// Backups + the signed control file (main server), syncing (pharmacy PC).
startRoleServices();
// The main server (and a PC not set up yet, which may become it) answers HTTPS and HTTP on the same port
// (platform/tls.ts); a pharmacy PC is only used from its own screen.
if (role !== "pharmacy" && process.env.HPS_NO_TLS !== "1") {
    const tls = serverCertificate();
    setTlsCert(tls.cert);
    await app.ready();
    const srv = dualServer(app.server, tls);
    await new Promise((ok, fail) => { srv.once("error", fail); srv.listen(PORT, HOST, () => ok()); });
    app.server.emit("listening"); // the HTTP server itself never listens; code waiting on its "listening" still runs
    console.log(`Hospital Pharmacy ${appVersion()} (${role}) on http(s)://${HOST === "0.0.0.0" ? "<this-pc-ip>" : HOST}:${PORT} — certificate ${tlsInfo().fingerprint}`);
}
else {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Hospital Pharmacy ${appVersion()} (${role}) on http://${HOST === "0.0.0.0" ? "<this-pc-ip>" : HOST}:${PORT}`);
}
