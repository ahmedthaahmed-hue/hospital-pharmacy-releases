// The hospital's logo as the app's icon on Windows (release 1.50, docs/DESKTOP.md): the Desktop and Start shortcuts and
// the app's window. When the hospital has a logo (Settings → Hospital → Hospital logo), each PC's server makes an icon
// file from it with the app's own window program (HospitalPharmacy.exe --make-icon), and puts the system's own icon
// back when the logo is removed. Checked at start and every ten minutes (a pharmacy PC gets the logo with the main
// server's settings).
//
// (1.56) Windows keeps the icons it has shown by the file they come from, so a new picture in the same icon.ico was
// not seen until the PC's icon cache was cleared. Now each logo gets an icon file of its own name
// (desktop\resources\app\icons\logo-<version>.ico, icons\current.txt naming it for the window, main.cjs), and the
// shortcuts (for every user of the PC, the taskbar's pinned ones too) are pointed at it: a new name is a new icon to
// Windows. icon.ico stays the system's own (a PC that had its logo written into it before 1.56 gets it back).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingStr, logoVersion } from "../core/settings.js";
import { appRoot, dataPath } from "./paths.js";
import { realRunner, windowProgram } from "./printing.js";
let runner = realRunner;
/** (tests) */
export function setIconRunner(r) { runner = r ?? realRunner; }
const appDir = () => join(appRoot(), "desktop", "resources", "app");
export const iconFile = () => join(appDir(), "icon.ico");
export const iconsDir = () => join(appDir(), "icons");
const STATE = () => dataPath("app-icon.json");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = () => { try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
}
catch {
    return {};
} };
const save = (s) => writeFileSync(STATE(), JSON.stringify(s));
/** For System health: whether the PC's icon is the hospital's logo, and why not. */
export function appIconStatus() {
    if (!windowProgram())
        return { state: "none" };
    const st = read();
    if (st.error)
        return { state: "failed", error: st.error, at: st.at };
    return st.file && existsSync(join(iconsDir(), st.file)) ? { state: "logo", at: st.at } : { state: "system", at: st.at };
}
/** Makes the icon match the hospital's logo, if it does not yet. Returns what it did. */
export async function syncAppIcon() {
    const exe = windowProgram(), ico = iconFile();
    if (!exe || !existsSync(ico))
        return "none";
    const logo = settingStr("hospital.logo"), want = logo ? logoVersion(logo) : "";
    const st = read();
    // before 1.56 the logo was written into icon.ico itself: the system's own goes back there
    if (st.wrote && sha(ico) === st.wrote && existsSync(dataPath("app-icon-system.ico")))
        copyFileSync(dataPath("app-icon-system.ico"), ico);
    delete st.wrote;
    const file = want ? `logo-${want.replace(/[^\w-]/g, "").slice(0, 16)}.ico` : "";
    if (want && st.version === want && st.file === file && existsSync(join(iconsDir(), file)) && !st.error && current() === file)
        return "same";
    if (!want && !st.file && !st.error)
        return "same";
    try {
        if (want) {
            mkdirSync(iconsDir(), { recursive: true });
            const src = dataPath("app-icon-logo.txt"), out = join(iconsDir(), file);
            writeFileSync(src, logo);
            try {
                rmSync(out, { force: true });
                await runner(exe, ["--make-icon", src, "--out", out, "--profile", dataPath("print-window")], 40_000, { quiet: true });
                if (!existsSync(out))
                    throw new Error("the icon was not made");
            }
            finally {
                rmSync(src, { force: true });
            }
            writeFileSync(join(iconsDir(), "current.txt"), file);
            await pointShortcuts(out);
            // the icons of earlier logos
            for (const f of readdirSync(iconsDir()))
                if (/^logo-.*\.ico$/.test(f) && f !== file)
                    rmSync(join(iconsDir(), f), { force: true });
            save({ version: want, file, at: new Date().toISOString() });
            return "logo";
        }
        rmSync(iconsDir(), { recursive: true, force: true });
        await pointShortcuts(ico);
        save({ at: new Date().toISOString() });
        return "system";
    }
    catch (e) {
        save({ ...st, error: String(e.message ?? e).slice(0, 300), at: new Date().toISOString() });
        throw e;
    }
}
const current = () => { try {
    return readFileSync(join(iconsDir(), "current.txt"), "utf8").trim();
}
catch {
    return "";
} };
/**
 * Points every Hospital Pharmacy shortcut of the PC at `icon`: the Desktop and Start menu ones every user sees, each
 * user's own Desktop one, and the ones pinned to their taskbars. Only shortcuts that open the app's window are changed.
 */
async function pointShortcuts(icon) {
    if (process.platform !== "win32" && runner === realRunner)
        return;
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$sh = New-Object -ComObject WScript.Shell",
        `$exe = ${q(join(appRoot(), "desktop", "HospitalPharmacy.exe"))}`,
        `$icon = ${q(icon)}`,
        "$dirs = @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))",
        "foreach ($u in Get-ChildItem -Directory (Split-Path $env:PUBLIC)) {",
        "  $dirs += (Join-Path $u.FullName 'Desktop'), (Join-Path $u.FullName 'AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'), (Join-Path $u.FullName 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs')",
        "}",
        "foreach ($d in $dirs) {",
        "  foreach ($f in Get-ChildItem -LiteralPath $d -Filter '*.lnk' -ErrorAction SilentlyContinue) {",
        "    $l = $sh.CreateShortcut($f.FullName)",
        "    if ($l.TargetPath -ne $exe) { continue }",
        "    $l.IconLocation = \"$icon,0\"",
        "    $l.Save()",
        "  }",
        "}",
    ].join("\n");
    await runner(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 60_000, { quiet: true });
}
let started = false;
export function startAppIconWatch() {
    if (started || process.platform !== "win32")
        return;
    started = true;
    const tick = () => void syncAppIcon().catch((e) => console.warn("[app-icon]", e.message));
    setTimeout(tick, 20_000).unref();
    setInterval(tick, 10 * 60_000).unref();
}
