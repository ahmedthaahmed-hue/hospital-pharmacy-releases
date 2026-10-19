// The database encryption key.
// Every database file (live, backups, replicas) is encrypted with SQLite3 Multiple Ciphers (ChaCha20-Poly1305). The key
// is 32 random bytes kept in <data>/db.key. On Windows the key file is sealed with DPAPI (machine scope): any account on
// this PC can open it, but the file copied to another PC is useless. The admin can download the key as a "recovery key"
// (Admin -> System) and keep it offline; with it the database can be opened anywhere (restore on a new PC, audits).
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
const PS = (script, input) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ${script}`], { input, encoding: "utf8", windowsHide: true }).trim();
function seal(hex) {
    if (process.platform !== "win32")
        return `plain:${hex}`;
    const b64 = PS("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'LocalMachine'))", hex);
    return `dpapi-machine:${b64}`;
}
function unseal(text) {
    const [kind, body] = [text.slice(0, text.indexOf(":")), text.slice(text.indexOf(":") + 1).trim()];
    if (kind === "plain")
        return body;
    if (kind === "dpapi-machine") {
        if (process.platform !== "win32")
            throw new Error("This key file is sealed for a Windows PC; use the recovery key.");
        return PS("[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'LocalMachine'))", body);
    }
    throw new Error(`Unknown key file format "${kind}"`);
}
export const isHexKey = (k) => /^[0-9a-f]{64}$/.test(k);
/** Normalises a recovery key typed by a person ("ab12 cd34 ..." / "AB12-CD34-...") to 64 lower-case hex digits. */
export function parseRecoveryKey(text) {
    const k = text.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (!isHexKey(k))
        throw new Error("A recovery key has 64 letters and digits (0-9, a-f).");
    return k;
}
export const formatRecoveryKey = (hex) => hex.toUpperCase().match(/.{4}/g).join("-");
/** The key for the database in this data folder, created (and sealed) on first use. DB_KEY overrides it (tests, recovery). */
export function loadOrCreateKey(keyFile) {
    if (process.env.DB_KEY)
        return parseRecoveryKey(process.env.DB_KEY);
    if (existsSync(keyFile))
        return unseal(readFileSync(keyFile, "utf8"));
    const hex = randomBytes(32).toString("hex");
    saveKey(keyFile, hex);
    return hex;
}
/** Stores a key for this data folder (new database, restore with a recovery key). */
export function saveKey(keyFile, hex) {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, seal(parseRecoveryKey(hex)) + "\n", { mode: 0o600 });
    try {
        chmodSync(keyFile, 0o600);
    }
    catch { /* Windows ACLs come from the install folder */ }
}
/** SQL for PRAGMA key / rekey with a hex key (the passphrase is the hex text; the cipher derives the real key from it). */
export const keyPragma = (hex) => `'${parseRecoveryKey(hex)}'`;
