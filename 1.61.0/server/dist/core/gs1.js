// Barcodes on medicine packs (release 1.5). Egyptian Drug Authority serialisation puts a GS1 DataMatrix on each pack:
// (01) GTIN, (17) expiry YYMMDD, (10) batch/lot, (21) serial number. A plain 1D barcode (EAN-13 / UPC / GTIN-14)
// carries only the product. Scanners type what they read like a keyboard; how the GS separator (ASCII 29) between
// variable-length fields arrives depends on the scanner's set-up, so this accepts the usual forms:
//   ]d2010622300001036517270131 10ABC123<GS>21XYZ      raw, with the symbology prefix and GS (\x1d)
//   (01)06223000010365(17)270131(10)ABC123(21)XYZ      human-readable with brackets
//   010622300001036517270131 10ABC123                    raw without separators (best effort, see parseGs1)
// and the "<GS>", "{GS}", "^]" or "|" text that some scanners are set to send instead of the control character.
/** Fixed lengths of the application identifiers that matter here (data length, after the AI). */
const FIXED = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6 };
/** Variable-length AIs (up to the GS or the end); max lengths per GS1. */
const VARIABLE = { "10": 20, "21": 20, "22": 20, "30": 8, "37": 8, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20 };
const GS = "\x1d";
/** The GTIN as 14 digits (EAN-13, UPC-A and GTIN-8 padded with zeros), or null if it is not one. */
export function normalizeGtin(code) {
    const s = code.replace(/\s+/g, "");
    if (!/^\d{8}$|^\d{12,14}$/.test(s))
        return null;
    const g = s.padStart(14, "0");
    return checkDigit(g.slice(0, 13)) === Number(g[13]) ? g : null;
}
/** GS1 mod-10 check digit of the digits before it. */
export function checkDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++)
        sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
    return (10 - (sum % 10)) % 10;
}
/** YYMMDD → YYYY-MM-DD; day 00 means the last day of the month (GS1). Null when not a date. */
export function gs1Date(s) {
    if (!/^\d{6}$/.test(s))
        return null;
    const y = 2000 + Number(s.slice(0, 2)), m = Number(s.slice(2, 4));
    let d = Number(s.slice(4, 6));
    if (m < 1 || m > 12)
        return null;
    const last = new Date(y, m, 0).getDate();
    if (d === 0)
        d = last;
    if (d > last)
        return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function clean(input) {
    return input.trim()
        .replace(/^\](d2|Q3|C1|e0|d1)/, "") // symbology identifier (DataMatrix / QR / GS1-128 …)
        .replace(/<GS>|\{GS\}|\^\]|\[GS\]|\\x1d|\\u001d/gi, GS)
        .replace(/\u001d+/g, GS);
}
/**
 * The GS1 fields of a scanned code, or null when it is not GS1 (a plain product barcode or anything else). Without
 * separators a variable-length field runs to the end: a batch at the end is read whole, but a batch that may be
 * followed by "21<serial>" cannot be told apart from it — then the batch is not guessed (ambiguous: the person types it).
 */
export function parseGs1(input) {
    const raw = input;
    let s = clean(input);
    if (s.includes("(")) {
        // human-readable: (AI)value(AI)value
        const out = { gtin: null, batch: null, expiry: null, serial: null, raw };
        const re = /\((\d{2,4})\)([^()]*)/g;
        let m, any = false;
        while ((m = re.exec(s))) {
            any = true;
            put(out, m[1], m[2].replace(GS, "").trim());
        }
        return any && (out.gtin || out.batch || out.expiry) ? out : null;
    }
    if (s.startsWith(GS))
        s = s.slice(1);
    if (!/^(01|02|17|10|21|11)\d/.test(s) || s.length < 16)
        return null;
    const out = { gtin: null, batch: null, expiry: null, serial: null, raw };
    let i = 0;
    while (i < s.length) {
        if (s[i] === GS) {
            i++;
            continue;
        }
        const ai = [2, 3, 4].map((n) => s.slice(i, i + n)).find((a) => a in FIXED || a in VARIABLE);
        if (!ai)
            break;
        i += ai.length;
        if (ai in FIXED) {
            put(out, ai, s.slice(i, i + FIXED[ai]));
            i += FIXED[ai];
        }
        else {
            let end = s.indexOf(GS, i);
            if (end < 0)
                end = s.length;
            let value = s.slice(i, Math.min(end, i + VARIABLE[ai]));
            // no separator after a batch that contains "21" with room for a serial after it: cannot tell where it ends
            if (ai === "10" && end === s.length && !s.includes(GS) && /.21.{4,}/.test(value)) {
                out.ambiguous = true;
                break;
            }
            put(out, ai, value);
            i += value.length;
        }
    }
    return out.gtin || out.batch || out.expiry ? out : null;
}
function put(out, ai, v) {
    if (ai === "01" || ai === "02")
        out.gtin = normalizeGtin(v) ?? v;
    else if (ai === "17")
        out.expiry = gs1Date(v);
    else if (ai === "10")
        out.batch = v || null;
    else if (ai === "21")
        out.serial = v || null;
}
/** The product code to look an item up by: the GS1 GTIN, or the scanned code itself (a GTIN normalised to 14 digits). */
export function productCode(input) {
    const g = parseGs1(input);
    if (g?.gtin)
        return g.gtin;
    const t = clean(input).replace(/\u001d/g, "");
    return normalizeGtin(t) ?? t;
}
