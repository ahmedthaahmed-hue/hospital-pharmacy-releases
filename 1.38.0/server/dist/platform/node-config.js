// This PC's place in the hospital network, kept in <data>/node.json.
//   server   - the main server: holds the hospital database, every pharmacy PC syncs with it
//   pharmacy - a pharmacy PC: works through the main server and keeps a local encrypted copy so it can carry on
//              alone (its own pharmacy's work) when the network is down
//   unset    - a fresh install that has not been set up yet (the setup screen asks)
//
// The PC's secrets in it (its token, the pinned certificate, the licence confirmation, whether verdicts must be signed)
// are sealed (release 1.37): encrypted and authenticated (AES-256-GCM) with a key derived from this PC's database key,
// which is itself sealed in db.key (DPAPI on Windows). A copy of the data folder taken elsewhere then gives no PC token
// to pose as this PC with, and an edited licence date, offline allowance or certificate is not taken. Once sealed, the
// database remembers it (schema_meta node_secrets_sealed), so deleting the sealed part and writing plain values back
// is not taken either. With no database key (DB_PLAIN, tests in memory) they stay in plain text, as before.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomUUID, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dataPath } from "./paths.js";
import { db } from "../db/index.js";
const SECRETS = ["nodeToken", "syncKey", "serverCert", "signedVerdicts", "licenceConfirmedAt", "licenceOfflineDays"];
const MARK = "node_secrets_sealed";
const file = () => dataPath("node.json");
let cached = null;
/** The config was read while the database (and so the key) was not open yet: read it again once it is. */
let readWithoutKey = false;
/** The sealed part as read, kept as it is when the file is written before the key can open it. */
let unopened = null;
/** The secrets were dropped (a sealed part that does not open, or one deleted): see secretsDropped. */
let dropped = false;
/**
 * This PC's sealed secrets could not be used (changed, deleted, or from another PC). The licence then counts as not
 * confirmed (platform/licence.ts) instead of starting a new allowance, and the sealed text is kept in
 * node.json.unreadable for support.
 */
export const secretsDropped = () => dropped;
function keepUnreadable(text) {
    try {
        writeFileSync(dataPath(`node.json.unreadable-${Date.now()}`), text + "\n", { mode: 0o600 });
    }
    catch { /* best effort */ }
}
/** This PC's database key, once the database is open; null when it has none (or is not open yet). */
function dbKey() { try {
    return db().key;
}
catch {
    return null;
} }
function sealKey(k) { return createHmac("sha256", Buffer.from(k, "utf8")).update("hps node.json secrets v1").digest(); }
function marked() {
    try {
        return !!db().get("SELECT 1 FROM schema_meta WHERE key = ?", [MARK]);
    }
    catch {
        return false;
    }
}
export function sealSecrets(s, key, nodeUuid) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", sealKey(key), iv);
    c.setAAD(Buffer.from(nodeUuid, "utf8"));
    const ct = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}
/** The secrets, or null when they were not sealed with this key for this installation (or were changed). */
export function openSecrets(text, key, nodeUuid) {
    try {
        if (!text.startsWith("v1:"))
            return null;
        const b = Buffer.from(text.slice(3), "base64");
        if (b.length < 28)
            return null;
        const d = createDecipheriv("aes-256-gcm", sealKey(key), b.subarray(0, 12), { authTagLength: 16 });
        d.setAAD(Buffer.from(nodeUuid, "utf8"));
        d.setAuthTag(b.subarray(12, 28));
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    }
    catch {
        return null;
    }
}
function withoutSecrets(c) {
    const o = { ...c };
    for (const k of SECRETS)
        delete o[k];
    return o;
}
function secretsOf(c) {
    const o = {};
    for (const k of SECRETS)
        if (c[k] !== undefined)
            o[k] = c[k];
    return o;
}
function readFile() {
    const stored = JSON.parse(readFileSync(file(), "utf8"));
    const { sealed, ...plain } = stored;
    const key = dbKey();
    readWithoutKey = !key;
    unopened = null;
    dropped = false;
    const edited = SECRETS.some((k) => plain[k] !== undefined);
    if (sealed) {
        if (!key) {
            unopened = sealed;
            return withoutSecrets(plain);
        }
        const s = openSecrets(sealed, key, plain.nodeUuid);
        if (!s) {
            console.warn("[node] this PC's sealed settings in node.json could not be opened (changed, or from another PC): set it up again (docs/DEPLOY.md)");
            dropped = true;
            keepUnreadable(sealed);
            return withoutSecrets(plain);
        }
        if (edited)
            console.warn("[node] values written into node.json by hand were not taken (this PC's own are sealed)");
        return { ...withoutSecrets(plain), ...s };
    }
    if (key && edited && marked()) {
        console.warn("[node] node.json lost its sealed part: the plain values in it were not taken; set this PC up again (docs/DEPLOY.md)");
        dropped = true;
        return withoutSecrets(plain);
    }
    return plain; // (an older version's plain file, or no key: sealed when next written with a key)
}
export function nodeConfig() {
    if (cached && !(readWithoutKey && dbKey()))
        return cached;
    if (existsSync(file()))
        cached = readFile();
    else {
        // A brand-new install is "unset" (the setup screen asks). An explicit NODE_ROLE wins. A pre-networking database
        // (users but no node.json) is upgraded to "server" by main.ts, which can see the users table.
        const role = process.env.NODE_ROLE === "server" || process.env.NODE_ROLE === "pharmacy" ? process.env.NODE_ROLE : "unset";
        cached = { role, nodeUuid: randomUUID(), name: hostname() };
        if (role !== "unset")
            saveNodeConfig(cached);
    }
    return cached;
}
export function saveNodeConfig(c) {
    cached = c;
    mkdirSync(dataPath(), { recursive: true });
    const key = dbKey();
    let out = c;
    if (key) {
        const s = secretsOf(c);
        out = Object.keys(s).length ? { ...withoutSecrets(c), sealed: sealSecrets(s, key, c.nodeUuid) } : withoutSecrets(c);
        readWithoutKey = false;
        unopened = null;
        try {
            db().untracked(() => db().run("INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, '1')", [MARK]));
        }
        catch { /* read-only */ }
    }
    else if (unopened)
        out = { ...withoutSecrets(c), sealed: unopened }; // (kept until the key can open it)
    const tmp = file() + ".tmp";
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, file());
}
/**
 * Writes node.json again with the database key now open: seals an older version's plain secrets (at start), and marks
 * a database copy just taken from the main server as this PC's sealed one (its schema_meta is the main server's).
 */
export function resealNodeConfig() {
    if (!dbKey() || !existsSync(file()))
        return;
    const c = nodeConfig();
    if (c.role !== "unset")
        saveNodeConfig(c);
}
export function updateNodeConfig(patch) { saveNodeConfig({ ...nodeConfig(), ...patch }); }
/** For tests. */
export function resetNodeConfigCache() { cached = null; readWithoutKey = false; unopened = null; dropped = false; }
