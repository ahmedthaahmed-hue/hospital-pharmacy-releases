// The machine licence: the app runs only on machines its owner licensed.
//
// A licence is a small document signed with the owner's release key (the same key that signs updates and the off
// switch, tools/release/sign-release.mjs `licence`). It names the machines it is for — by a code derived from the
// operating system's machine id, which lives outside the app folder, so copying the install (or a backup) to another
// computer does not carry it — and how many pharmacy PCs the hospital may connect.
//
//   main server   needs a licence naming its machine code. Without one it works for a 14-day grace period (so an
//                 update that brings licensing never stops a running hospital), then locks with a "licence required"
//                 screen showing its code. The licence is fetched from the releases repo (licences/<code>.licence) or
//                 uploaded on that screen / in Admin -> Updates. The licence also caps how many pharmacy PCs connect.
//   pharmacy PC   is licensed through its main server: every heartbeat confirms it. A PC that has not been confirmed
//                 for the licence's offline allowance (30 days by default) locks until it reaches its server again.
//
// Only compiled installs enforce it (development and tests run from source; tests opt in with HPS_LICENCE=enforce).
// Honest limit: code on a machine someone else controls can be patched; the data stays encrypted with a key sealed to
// the machine (keys.ts), which is the real protection for the data.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { hostname, networkInterfaces, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { sep, win32 } from "node:path";
import { db } from "../db/index.js";
import { nowIso, toLocalIso, parseLocal } from "../lib/time.js";
import { nodeConfig, updateNodeConfig } from "./node-config.js";
import { dataPath } from "./paths.js";
import { releasesBase, verifySignature } from "./releases.js";
export const GRACE_DAYS = 14;
export const DEFAULT_OFFLINE_DAYS = 30;
const DAY = 86_400_000;
/** Running compiled code (an installed release) rather than from source. */
const compiled = () => fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
/** Whether this install enforces the licence: compiled code (an installed release), or HPS_LICENCE=enforce. */
export function licenceEnforced() {
    if (process.env.HPS_LICENCE === "enforce")
        return true;
    return compiled();
}
const WIN_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
function winTools() {
    const sys = win32.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");
    const fromReg = (out) => /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{8,})/.exec(out)?.[1]?.toLowerCase() ?? null;
    return [
        // The 64-bit view: the id is not under WOW6432Node, where a 32-bit process would look by default.
        [win32.join(sys, "reg.exe"), ["query", WIN_KEY, "/v", "MachineGuid", "/reg:64"], fromReg],
        [win32.join(sys, "reg.exe"), ["query", WIN_KEY, "/v", "MachineGuid"], fromReg],
        // reg.exe can be blocked by policy ("prevent access to registry editing tools"); .NET reads the same value.
        [win32.join(sys, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
                "[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64').OpenSubKey('SOFTWARE\\Microsoft\\Cryptography').GetValue('MachineGuid')"],
            (out) => /^\s*([0-9A-Fa-f-]{8,})\s*$/.exec(out)?.[1]?.toLowerCase() ?? null],
    ];
}
const macTools = () => [["/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], (out) => /IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null]];
/** How the operating system's machine id is read (tests replace it). */
export const machineIdSource = {
    /** Whether this system always has a machine id, so failing to read it is a hiccup rather than "there is none". */
    expected: () => process.platform === "win32" || process.platform === "darwin",
    read() {
        if (process.platform === "linux") {
            for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
                try {
                    const v = readFileSync(f, "utf8").trim();
                    if (v)
                        return v;
                }
                catch { /* the next file */ }
            }
            return null;
        }
        const tools = process.platform === "win32" ? winTools() : process.platform === "darwin" ? macTools() : [];
        for (const [cmd, args, parse] of tools) {
            try {
                const id = parse(execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }));
                if (id)
                    return id;
            }
            catch { /* the next way */ }
        }
        return null;
    },
};
let code = null;
let retry = null;
const hashCode = (basis) => createHash("sha256").update(`hps-licence-v1|${basis}`).digest("hex").slice(0, 32);
/**
 * This machine's licence code (32 hex characters), or null while the operating system's machine id cannot be read
 * (Windows/macOS: it is read again every minute in the background rather than guessed). HPS_MACHINE_CODE pins the
 * code for tests — only where the licence is not enforced by default (running from source), never in an install.
 */
export function machineCodeOrNull() {
    const o = process.env.HPS_MACHINE_CODE && !compiled() ? normaliseCode(process.env.HPS_MACHINE_CODE) : "";
    if (o)
        return o;
    if (code)
        return code;
    const id = machineIdSource.read();
    if (id)
        return (code = hashCode(`id|${platform()}|${id}`));
    if (!machineIdSource.expected()) {
        // No machine id on this system at all (some Linux installs): the host name and network cards instead.
        const macs = Object.values(networkInterfaces()).flat().filter((n) => n && !n.internal && n.mac && n.mac !== "00:00:00:00:00:00")
            .map((n) => n.mac.toLowerCase()).sort().join(",");
        return (code = hashCode(`host|${platform()}|${hostname()}|${macs}`));
    }
    if (!retry) {
        retry = setTimeout(() => { retry = null; machineCodeOrNull(); }, 60_000);
        retry.unref?.();
    }
    return null;
}
/** This machine's licence code; throws when it cannot be read right now. */
export function machineCode() {
    const c = machineCodeOrNull();
    if (!c)
        throw new Error("This computer's code cannot be read right now — wait a minute and try again, or restart the computer");
    return c;
}
/** Tests only: forget the code read so far. */
export function resetMachineCode() { code = null; if (retry)
    clearTimeout(retry); retry = null; }
/** For reading out or typing: 8 groups of 4. */
export const displayCode = (c = machineCode()) => c.toUpperCase().match(/.{1,4}/g).join("-");
export const normaliseCode = (s) => s.toLowerCase().replace(/[^0-9a-f]/g, "");
/* ---------------- the licence file ---------------- */
const licenceFile = () => dataPath("licence.licence");
/**
 * Parse and verify a licence file ({ payload, sig }); throws a clear message when it is not usable here. forCode null
 * (this machine's code cannot be read right now) checks everything but the machine.
 */
export function verifyLicenceFile(text, forCode = machineCode()) {
    let env;
    try {
        env = JSON.parse(text);
    }
    catch {
        throw new Error("This is not a licence file");
    }
    if (typeof env?.payload !== "string" || typeof env?.sig !== "string")
        throw new Error("This is not a licence file");
    if (!verifySignature(env.payload, env.sig.trim()))
        throw new Error("This licence is not signed by the system's owner");
    let l;
    try {
        l = JSON.parse(env.payload);
    }
    catch {
        throw new Error("This licence is damaged");
    }
    if (l?.typ !== "hps-licence" || l.v !== 1 || !Array.isArray(l.machines))
        throw new Error("This licence is for a different product or version");
    if (forCode !== null && !l.machines.map((m) => normaliseCode(String(m))).includes(forCode))
        throw new Error(`This licence is for another computer (this one is ${displayCode(forCode)})`);
    return { licence: l, text };
}
let cache = null;
/**
 * The installed licence for this machine, or null (missing, unsigned, or for another computer). While this machine's
 * code cannot be read (a hiccup reading the Windows machine id) an installed owner-signed licence is trusted, so a
 * licensed hospital does not lock over it; it is checked against the machine again once the code can be read.
 */
export function installedLicence() {
    const f = licenceFile();
    if (!existsSync(f))
        return null;
    try {
        const st = statSync(f);
        const mc = machineCodeOrNull();
        const stamp = `${st.mtimeMs}:${st.size}:${mc}`;
        if (cache && cache.stamp === stamp)
            return cache.licence;
        let licence = null;
        try {
            licence = verifyLicenceFile(readFileSync(f, "utf8"), mc).licence;
        }
        catch {
            licence = null;
        }
        cache = { stamp, licence };
        return licence;
    }
    catch {
        return null;
    }
}
/** Install a licence file on this main server (verified first). */
export function installLicence(text) {
    if (nodeConfig().role === "pharmacy")
        throw new Error("A pharmacy PC is licensed through its main server; install the licence there");
    const { licence } = verifyLicenceFile(text);
    mkdirSync(dataPath(), { recursive: true });
    const tmp = `${licenceFile()}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, licenceFile());
    cache = null;
    try {
        db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "system.licence.install", "system", JSON.stringify({ hospital: licence.hospital ?? null, pharmacyPcs: licence.pharmacyPcs ?? null })]);
    }
    catch { /* audit best-effort */ }
    return licence;
}
let lastFetchAt = 0;
/** Fetch this machine's licence from the releases repo (licences/<code>.licence) and install it. */
export async function fetchLicence(force = false) {
    if (!force && Date.now() - lastFetchAt < 30_000)
        throw new Error("Checked a moment ago — try again in half a minute");
    lastFetchAt = Date.now();
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    try {
        const r = await fetch(`${releasesBase()}/licences/${machineCode()}.licence`, { signal: c.signal, cache: "no-store" });
        if (r.status === 404)
            throw new Error(`No licence has been published for this computer yet (${displayCode()}) — send this code to the system's owner`);
        if (!r.ok)
            throw new Error(`Could not reach the licence server (${r.status})`);
        return installLicence(await r.text());
    }
    catch (e) {
        if (e?.name === "AbortError")
            throw new Error("Could not reach the licence server (timed out)");
        // fetch's own network failure says only "fetch failed"
        if (e instanceof TypeError)
            throw new Error("Could not reach the licence server — check this computer's internet connection, or upload the licence file");
        throw e;
    }
    finally {
        clearTimeout(t);
    }
}
/* ---------------- state ---------------- */
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const realNowIso = () => toLocalIso(new Date()); // not nowIso(): a request replayed from a pharmacy PC runs at an old time
const parseOr = (s, fallback) => {
    try {
        const t = s ? parseLocal(s.slice(0, 19)).getTime() : NaN;
        return Number.isFinite(t) ? t : fallback;
    }
    catch {
        return fallback;
    }
};
/**
 * When this main server first ran on this machine without a licence (the start of its grace period). Kept per machine
 * code in the database: a database restored onto a replacement server (old one broken) gets that machine its own grace
 * period instead of locking at once, while the same machine never gets a second one.
 */
function graceSince(mc) {
    const key = `licence_grace_since:${mc ?? "unreadable"}`;
    const v = META(key);
    if (v)
        return new Date(parseOr(v, Date.now()));
    const now = realNowIso();
    db().untracked(() => db().run("INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)", [key, now]));
    return parseLocal(now);
}
export function licenceStatus() {
    const role = nodeConfig().role;
    const mc = machineCodeOrNull();
    const base = { machineCode: mc ? displayCode(mc) : "", hospital: null, pharmacyPcs: null, offlineDays: DEFAULT_OFFLINE_DAYS, graceUntil: null, message: null };
    if (!licenceEnforced() || role === "unset")
        return { ...base, state: "not_required", required: false };
    if (role === "pharmacy") {
        const c = nodeConfig();
        const days = c.licenceOfflineDays ?? DEFAULT_OFFLINE_DAYS;
        // The allowance runs from the main server's last confirmation. A PC that has none yet (set up, or updated, before
        // licensing) starts it now; so does one whose confirmation lies in the future (a clock that was wrong, or an edited
        // node.json), which would otherwise never run out.
        let lastMs = parseOr(c.licenceConfirmedAt, NaN);
        if (!Number.isFinite(lastMs) || lastMs > Date.now() + 3_600_000) {
            lastMs = Date.now();
            updateNodeConfig({ licenceConfirmedAt: realNowIso() });
        }
        const stale = Date.now() - lastMs > days * DAY;
        return { ...base, offlineDays: days, required: true, state: stale ? "unlicensed" : "licensed",
            message: stale ? `This PC has not reached its main server for more than ${days} days. Connect it to the hospital network so the main server can confirm its licence.` : null };
    }
    const l = installedLicence();
    if (l)
        return { ...base, required: true, state: "licensed", hospital: l.hospital ?? null, pharmacyPcs: l.pharmacyPcs ?? null, offlineDays: l.offlineDays ?? DEFAULT_OFFLINE_DAYS };
    const until = new Date(graceSince(mc).getTime() + GRACE_DAYS * DAY);
    const inGrace = Date.now() < until.getTime();
    return { ...base, required: true, state: inGrace ? "grace" : "unlicensed", graceUntil: toLocalIso(until),
        message: inGrace ? null : mc ? `This computer needs a licence from the system's owner. Send them this computer's code: ${displayCode(mc)}.`
            : "This computer's code cannot be read right now, so its licence cannot be checked. Restart the computer; if this stays, contact the system's owner." };
}
/** Main server: how many pharmacy PCs the licence allows (null = no limit, e.g. during the grace period). */
export function pharmacyPcLimit() {
    if (!licenceEnforced())
        return null;
    const n = installedLicence()?.pharmacyPcs;
    return typeof n === "number" && n >= 0 ? n : null;
}
/** Pharmacy PC: the main server confirmed this PC's licence (heartbeat). Written at most hourly. */
export function confirmFromServer(offlineDays) {
    const c = nodeConfig();
    const last = parseOr(c.licenceConfirmedAt, 0);
    const days = typeof offlineDays === "number" && offlineDays > 0 ? offlineDays : DEFAULT_OFFLINE_DAYS;
    // abs: a confirmation stamped by a clock that ran ahead is replaced once the clock is right again
    if (Math.abs(Date.now() - last) > 3_600_000 || c.licenceOfflineDays !== days)
        updateNodeConfig({ licenceConfirmedAt: realNowIso(), licenceOfflineDays: days });
}
