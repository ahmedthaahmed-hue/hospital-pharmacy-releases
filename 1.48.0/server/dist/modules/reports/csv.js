function cell(v) {
    if (v === null || v === undefined)
        return "";
    let s = typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v);
    // CSV/formula injection: free text (walk-in names, notes) starting with = + - @ would run as a formula in Excel.
    // Prefix it with an apostrophe; numbers (negative return quantities) and plain signed numbers stay as they are.
    if (typeof v !== "number" && (/^[=@\t\r]/.test(s) || (/^[+-]./.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s))))
        s = `'${s}`;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** CSV text with a UTF-8 BOM so Excel opens Arabic correctly; CRLF line endings. */
export function toCsv(rows, cols) {
    const lines = [cols.map((c) => cell(c.header)).join(",")];
    for (const r of rows)
        lines.push(cols.map((c) => cell(c.value(r))).join(","));
    return "﻿" + lines.join("\r\n") + "\r\n";
}
export function sendCsv(reply, name, rows, cols) {
    const file = `${name}.csv`;
    return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${file.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`)
        .send(toCsv(rows, cols));
}
