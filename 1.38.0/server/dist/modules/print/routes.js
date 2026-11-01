import { z } from "zod";
import { audit, HttpError, parse } from "../../lib/http.js";
import { isInternal } from "../../platform/hub.js";
import { directPrintingAvailable, listPrinters, printerChoice, printHtmlDirect, setPrinterChoice } from "../../platform/printing.js";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
/** The request comes from this PC's own screen (a pharmacy PC's work replayed here is not: it comes from inside). */
const fromThisPc = (req) => LOOPBACK.test(req.ip) && !isInternal(req);
function onThisPc(req) {
    if (!fromThisPc(req))
        throw new HttpError(403, "Printers are chosen on the PC itself (open the app on that PC)");
    if (!directPrintingAvailable())
        throw new HttpError(409, "Printing without the print window works on Windows only");
}
const zPrinter = z.string().trim().min(1).max(200).nullable();
const SETUP = z.object({ label: zPrinter.optional(), document: zPrinter.optional(), labelDpi: z.union([z.literal(150), z.literal(203), z.literal(300), z.literal(600)]).optional() });
const PRINT = z.object({ kind: z.enum(["label", "document"]), html: z.string().min(20).max(15 * 1024 * 1024), printer: z.string().trim().min(1).max(200).optional() });
export default async function routes(app) {
    /** Whether this screen prints by itself, and on what (the screens ask before each print). */
    app.get("/setup", async (req) => ({ available: directPrintingAvailable() && fromThisPc(req), here: fromThisPc(req), ...printerChoice() }));
    app.get("/printers", async (req) => {
        onThisPc(req);
        try {
            return { printers: await listPrinters() };
        }
        catch (e) {
            throw new HttpError(502, `Could not list this PC's printers: ${e?.message ?? e}`);
        }
    });
    app.put("/setup", async (req) => {
        onThisPc(req);
        const body = parse(SETUP, req.body);
        const next = setPrinterChoice(body);
        audit(req, "print.setup", "printer", null, next);
        return { available: true, here: true, ...next };
    });
    /** Print a page on this PC's printer for its kind (or the one named: a test print from the Printers screen). */
    app.post("/direct", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
        onThisPc(req);
        const { kind, html, printer } = parse(PRINT, req.body);
        const c = printerChoice();
        const target = printer ?? c[kind];
        if (!target)
            throw new HttpError(409, "No printer is chosen for this: the print window opens instead");
        try {
            const r = await printHtmlDirect(html, { kind, printer: target, dpi: c.labelDpi });
            return { ok: true, printer: target, result: r.pages };
        }
        catch (e) {
            throw new HttpError(502, `Could not print on ${target}: ${e?.message ?? e}`);
        }
    });
}
