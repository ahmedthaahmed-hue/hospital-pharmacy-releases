// The hospital's logo as the app's icon on Windows (release 1.50, docs/DESKTOP.md): the Desktop and Start shortcuts and
// the app's window take their icon from desktop\resources\app\icon.ico. When the hospital has a logo (Settings →
// Hospital → Hospital logo), each PC's server makes that file from it with the app's own window program
// (HospitalPharmacy.exe --make-icon), and puts the system's own icon back when the logo is removed. An update brings
// the system's icon back with its files: it is made again at the next start. Checked at start and every ten minutes
// (a pharmacy PC gets the logo with the main server's settings).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingStr, logoVersion } from "../core/settings.js";
import { appRoot, dataPath } from "./paths.js";
import { realRunner, windowProgram } from "./printing.js";
let runner = realRunner;
/** (tests) */
export function setIconRunner(r) { runner = r ?? realRunner; }
export const iconFile = () => join(appRoot(), "desktop", "resources", "app", "icon.ico");
const STATE = () => dataPath("app-icon.json");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const read = () => { try {
    return JSON.parse(readFileSync(STATE(), "utf8"));
}
catch {
    return { wrote: "", version: "" };
} };
/** Makes the icon file match the hospital's logo, if it does not yet. Returns what it did. */
export async function syncAppIcon() {
    const exe = windowProgram(), ico = iconFile();
    if (!exe || !existsSync(ico))
        return "none";
    const logo = settingStr("hospital.logo"), want = logo ? logoVersion(logo) : "";
    const st = read(), cur = sha(ico);
    const ours = cur === st.wrote;
    // a file we did not write is the system's own (just installed or updated): kept, to put back later
    if (!ours)
        copyFileSync(ico, dataPath("app-icon-system.ico"));
    if (want && ours && st.version === want)
        return "same";
    if (!want) {
        if (!ours || !st.version)
            return "same";
        copyFileSync(dataPath("app-icon-system.ico"), ico);
        writeFileSync(STATE(), JSON.stringify({ wrote: sha(ico), version: "" }));
        refreshShell();
        return "system";
    }
    const src = dataPath("app-icon-logo.txt"), out = dataPath("app-icon-new.ico");
    writeFileSync(src, logo);
    try {
        rmSync(out, { force: true });
        await runner(exe, ["--make-icon", src, "--out", out, "--profile", dataPath("print-window")], 40_000, { quiet: true });
        if (!existsSync(out))
            throw new Error("the icon was not made");
        copyFileSync(out, ico);
    }
    finally {
        rmSync(src, { force: true });
        rmSync(out, { force: true });
    }
    writeFileSync(STATE(), JSON.stringify({ wrote: sha(ico), version: want }));
    refreshShell();
    return "logo";
}
/** Windows keeps icons it has shown: ask it to look again (best effort). */
function refreshShell() {
    if (process.platform !== "win32")
        return;
    const ie4 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ie4uinit.exe");
    if (existsSync(ie4))
        void runner(ie4, ["-show"], 15_000, { quiet: true }).catch(() => undefined);
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
