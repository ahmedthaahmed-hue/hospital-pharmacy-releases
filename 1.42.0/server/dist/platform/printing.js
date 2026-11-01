// Direct printing (release 1.20): this PC prints labels and documents straight to the printer chosen for them, with
// no print window. The screens send what they would have printed (the same HTML, with the label size or A4); here it
// becomes a PDF (Microsoft Edge, headless — it lays out labels and pages exactly as the browser does) and
// deploy/print/print-pdf.ps1 draws each page with Windows' own PDF renderer onto the chosen printer, at the page's
// real size. Nothing is installed for it: Edge, Windows.Data.Pdf and System.Drawing are part of Windows 10 and 11.
//
// Which printer prints what is this PC's own choice (<data>/printers.json, never in the database copy): one for
// labels, one for documents (reports, lists, the medication list), each a printer of this PC or "ask every time"
// (the browser's print window, as before). Only the browser on this PC itself uses it: a screen opened from another
// computer prints there, with its print window.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appRoot, dataPath } from "./paths.js";
const CONFIG = () => dataPath("printers.json");
const DEFAULT_CHOICE = { label: null, document: null, labelDpi: 203 };
const DPIS = [150, 203, 300, 600];
/** The printers this PC prints to by itself (null: ask every time, with the print window). */
export function printerChoice() {
    try {
        const c = JSON.parse(readFileSync(CONFIG(), "utf8"));
        const name = (v) => (typeof v === "string" && v.trim() && v.length <= 200 ? v : null);
        return { label: name(c.label), document: name(c.document), labelDpi: DPIS.includes(c.labelDpi) ? c.labelDpi : DEFAULT_CHOICE.labelDpi };
    }
    catch {
        return { ...DEFAULT_CHOICE };
    }
}
export function setPrinterChoice(next) {
    const c = { ...printerChoice(), ...next };
    writeFileSync(CONFIG(), JSON.stringify(c, null, 1));
    return c;
}
const realRunner = (file, args, timeoutMs, opts = {}) => new Promise((ok, fail) => {
    if (opts.quiet) {
        const p = spawn(file, args, { windowsHide: true, stdio: "ignore" });
        const t = setTimeout(() => { p.kill(); fail(new Error(`${file} did not finish in time`)); }, timeoutMs);
        p.once("error", (e) => { clearTimeout(t); fail(e); });
        p.once("exit", (code) => { clearTimeout(t); if (code === 0)
            ok("");
        else
            fail(new Error(`${file} stopped (${code})`)); });
        return;
    }
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err)
            fail(new Error((String(stderr || "").trim().split(/\r?\n/).filter(Boolean).pop()) || err.message));
        else
            ok(String(stdout));
    });
});
let runner = realRunner;
/** Tests: run something else instead of PowerShell and Edge. */
export function setPrintRunner(r) { runner = r ?? realRunner; }
let platform = process.platform;
/** Tests: act as Windows (or not). */
export function setPrintPlatform(p) { platform = p ?? process.platform; }
/** Direct printing works on Windows only (elsewhere every print uses the browser's print window). */
export const directPrintingAvailable = () => platform === "win32";
const powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const script = (name) => join(appRoot(), "deploy", "print", name);
const ps = (name, args, timeoutMs) => runner(powershell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script(name), ...args], timeoutMs);
/** Microsoft Edge (every Windows 10 and 11 has it), else Google Chrome (HPS_PDF_BROWSER: another one). */
export function browserForPdf() {
    if (process.env.HPS_PDF_BROWSER)
        return process.env.HPS_PDF_BROWSER;
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots)
        for (const p of [["Microsoft", "Edge", "Application", "msedge.exe"], ["Google", "Chrome", "Application", "chrome.exe"]]) {
            const f = join(r, ...p);
            if (existsSync(f))
                return f;
        }
    return null;
}
/** The printers of this PC (the app runs as SYSTEM: printers installed for this PC, not one user's own). */
export async function listPrinters() {
    if (!directPrintingAvailable())
        return [];
    const out = await ps("printers.ps1", [], 20_000);
    const list = JSON.parse(out.trim() || "[]");
    return (Array.isArray(list) ? list : [list]).filter((p) => p && typeof p.name === "string")
        .map((p) => ({ name: p.name, isDefault: !!p.isDefault, offline: !!p.offline, driver: p.driver ?? undefined, port: p.port ?? undefined }));
}
let queue = Promise.resolve();
/**
 * Print `html` (a whole page: the screens' print markup with its stylesheets) on `printer`: labels at their own page
 * size and `dpi`, documents on A4. One job at a time (labels come out in the order they were printed).
 */
export function printHtmlDirect(html, opts) {
    const job = queue.then(() => printOnce(html, opts));
    queue = job.catch(() => undefined);
    return job;
}
async function printOnce(html, opts) {
    if (!directPrintingAvailable())
        throw new Error("Direct printing works on Windows only");
    const edge = browserForPdf();
    if (!edge)
        throw new Error("Microsoft Edge is not on this PC: it is needed to print without the print window");
    const dir = dataPath("print-jobs", randomUUID());
    mkdirSync(dir, { recursive: true });
    try {
        const page = join(dir, "print.html"), pdf = join(dir, "print.pdf");
        writeFileSync(page, html);
        // Edge lays the page out as the screen's browser would (the @page size of a label or A4) and saves it as a PDF
        // (its own stylesheets and fonts come from this PC's app, whose certificate it need not know)
        await runner(edge, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
            `--user-data-dir=${dataPath("print-browser")}`, "--no-pdf-header-footer", "--virtual-time-budget=4000",
            `--print-to-pdf=${pdf}`, pathToFileURL(page).href], 60_000, { quiet: true });
        if (runner === realRunner && !existsSync(pdf))
            throw new Error("Edge did not make the page to print");
        const out = await ps("print-pdf.ps1", ["-Printer", opts.printer, "-Pdf", pdf, "-Dpi", String(opts.kind === "label" ? opts.dpi ?? 203 : 200),
            ...(opts.kind === "document" ? ["-A4"] : [])], 120_000);
        return { pages: out.trim() };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
