// The app's own window on a PC installed before it existed (release 1.54, docs/DESKTOP.md → Updates). Automatic updates
// carry the window's code (desktop\resources\app) but not its engine (Electron, over 300 MB unpacked: too large for
// the releases repository), so such a PC kept opening the system in its browser until its installer was run again.
// Now the PC's server installs the engine itself, the way the installer does (tools/installer/stage.mjs): Electron's
// Windows build from Electron's GitHub releases, refused unless it matches the pinned checksum, unpacked with Windows'
// own tar, electron.exe renamed HospitalPharmacy.exe. A pharmacy PC asks the main server for it first (its sync
// connection; many have no internet), then GitHub. Then the Desktop and Start menu shortcuts open the window instead of
// the browser. The server runs as SYSTEM, so it may change the shortcuts every user of the PC sees.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot, dataPath } from "./paths.js";
import { realRunner } from "./printing.js";
/** The engine: the same pin as desktop/electron.json (a test keeps the two equal). */
export let ENGINE = { version: "44.9.3", sha256: "41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c" };
export const engineZipName = () => `electron-v${ENGINE.version}-win32-x64.zip`;
export const engineUrl = () => `https://github.com/electron/electron/releases/download/v${ENGINE.version}/${engineZipName()}`;
export const engineCache = () => dataPath("window-engine", engineZipName());
const desktop = () => join(appRoot(), "desktop");
export const windowExe = () => join(desktop(), "HospitalPharmacy.exe");
/** (tests) */
let runner = realRunner;
let fetcher = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
    if (!r.ok)
        throw new Error(`could not download the window (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
};
export function setEngineTestHooks(h) {
    runner = h?.runner ?? realRunner;
    if (h?.fetcher !== undefined)
        fetcher = h.fetcher ?? fetcher;
    if (h?.pin)
        ENGINE = h.pin;
}
let status = { state: "missing" };
export const engineStatus = () => existsSync(windowExe()) ? { state: "present" } : process.platform !== "win32" && runner === realRunner ? { state: "not_windows" } : status;
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** The engine's download, checked: from the cache, a pharmacy PC's main server, or GitHub. */
async function engineZip(fromServer) {
    if (existsSync(engineCache())) {
        const b = readFileSync(engineCache());
        if (sha(b) === ENGINE.sha256)
            return b;
        rmSync(engineCache(), { force: true });
    }
    let zip = null;
    if (fromServer)
        zip = await fromServer().catch(() => null);
    if (!zip || sha(zip) !== ENGINE.sha256)
        zip = await fetcher(engineUrl());
    if (sha(zip) !== ENGINE.sha256)
        throw new Error(`${engineZipName()} does not match its pinned checksum: refused`);
    mkdirSync(join(engineCache(), ".."), { recursive: true });
    writeFileSync(engineCache(), zip);
    return zip;
}
/** For the main server's pharmacy PCs (GET /api/sync/window-engine): the checked download, fetched once. */
export const engineZipForPcs = () => engineZip();
/** Unpacks the engine into desktop\ beside the window's code; HospitalPharmacy.exe appears last, when all is in place. */
async function unpack(zip) {
    const tmp = join(desktop(), ".engine-new");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const zipFile = join(tmp, "engine.zip");
    writeFileSync(zipFile, zip);
    // Windows' own tar (bsdtar, Windows 10 and later) reads zip files
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await runner(tar, ["-xf", zipFile, "-C", tmp], 10 * 60_000);
    rmSync(zipFile, { force: true });
    if (!existsSync(join(tmp, "electron.exe")))
        throw new Error("electron.exe is not in the download");
    rmSync(join(tmp, "resources", "default_app.asar"), { force: true }); // Electron's demo app
    if (existsSync(join(tmp, "locales")))
        for (const f of readdirSync(join(tmp, "locales")))
            if (!["en-US.pak", "ar.pak"].includes(f))
                rmSync(join(tmp, "locales", f), { force: true });
    // everything but the program itself, over desktop\ (the window's own code in resources\app is kept)
    for (const f of readdirSync(tmp)) {
        if (f === "electron.exe")
            continue;
        cpSync(join(tmp, f), join(desktop(), f), { recursive: true, force: true });
    }
    renameSync(join(tmp, "electron.exe"), windowExe());
    rmSync(tmp, { recursive: true, force: true });
}
/** The shortcuts every user of the PC sees open the window (in place of the browser's .url shortcuts of before 1.46). */
async function pointShortcuts(port) {
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const exe = windowExe(), icon = join(desktop(), "resources", "app", "icon.ico");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$sh = New-Object -ComObject WScript.Shell",
        "foreach ($dir in @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))) {",
        "  Remove-Item -LiteralPath (Join-Path $dir 'Hospital Pharmacy.url') -Force -ErrorAction SilentlyContinue",
        "  $l = $sh.CreateShortcut((Join-Path $dir 'Hospital Pharmacy.lnk'))",
        `  $l.TargetPath = '${exe.replace(/'/g, "''")}'`,
        `  $l.Arguments = '--port ${port}'`,
        `  $l.WorkingDirectory = '${desktop().replace(/'/g, "''")}'`,
        `  $l.IconLocation = '${icon.replace(/'/g, "''")},0'`,
        "  $l.Save()",
        "}",
    ].join("\n");
    await runner(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 60_000);
}
let busy = null;
/**
 * Installs the window on this PC if it has no window yet (a Windows PC whose installer predates 1.46), then points the
 * shortcuts at it. Safe to call again: a PC that has the window is left alone.
 */
export function ensureWindow(port, fromServer) {
    if (existsSync(windowExe()))
        return Promise.resolve({ state: "present" });
    if (process.platform !== "win32" && runner === realRunner)
        return Promise.resolve({ state: "not_windows" });
    // the window's code comes with every update; without it there is nothing to run the engine with
    if (!existsSync(join(desktop(), "resources", "app", "main.cjs")))
        return Promise.resolve({ state: "missing", error: "the window's code is not here yet (it comes with the next update)" });
    busy ??= (async () => {
        status = { state: "installing", at: new Date().toISOString() };
        try {
            await unpack(await engineZip(fromServer));
            await pointShortcuts(port);
            status = { state: "present", at: new Date().toISOString() };
        }
        catch (e) {
            status = { state: "failed", error: String(e.message ?? e).slice(0, 300), at: new Date().toISOString() };
        }
        return status;
    })().finally(() => { busy = null; });
    return busy;
}
let started = false;
/** At start (after a minute) and every six hours while the window is missing. */
export function startWindowWatch(port, fromServer) {
    if (started || process.platform !== "win32")
        return;
    started = true;
    const tick = () => { if (!existsSync(windowExe()))
        void ensureWindow(port, fromServer); };
    setTimeout(tick, 60_000).unref();
    setInterval(tick, 6 * 3600_000).unref();
}
