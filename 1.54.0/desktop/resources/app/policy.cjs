// What the app window decides, kept apart from Electron so it can be tested with plain Node (policy.test.cjs).
"use strict";

/**
 * The window's command line. Window mode (the Desktop shortcut): `--port 8080` or `--url http://host:port/`.
 * PDF mode (the server's direct printing, platform/printing.ts): `--print-pdf <page.html> --out <file.pdf>
 * --profile <folder>`. Chromium adds switches of its own; anything not ours is ignored.
 */
function parseArgs(argv) {
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  // (1.50) the hospital's logo as the Windows icon of the shortcuts and the window (platform/app-icon.ts)
  const iconFrom = val("--make-icon");
  if (iconFrom) {
    const out = val("--out");
    if (!out) throw new Error("--make-icon needs --out <file.ico>");
    return { mode: "icon", image: iconFrom, out, profile: val("--profile") };
  }
  const pdfPage = val("--print-pdf");
  if (pdfPage) {
    const out = val("--out");
    if (!out) throw new Error("--print-pdf needs --out <file.pdf>");
    return { mode: "pdf", page: pdfPage, out, profile: val("--profile") };
  }
  const url = val("--url");
  if (url) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("--url must be http or https");
    return { mode: "window", base: u.origin + "/" };
  }
  const port = Number(val("--port") ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a port number");
  return { mode: "window", base: `http://localhost:${port}/` };
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const isLocalHost = (host) => LOCAL.has(String(host).toLowerCase());

/** The same app: its origin, with localhost and 127.0.0.1 counted as one. */
function isAppUrl(target, base) {
  let t, b;
  try { t = new URL(target); b = new URL(base); } catch { return false; }
  if (t.protocol !== b.protocol || t.port !== b.port) return false;
  return t.hostname === b.hostname || (isLocalHost(t.hostname) && isLocalHost(b.hostname));
}

/**
 * A certificate the window may accept without knowing it: the app's own (each server makes its own, platform/tls.ts),
 * on this PC or at the address the window was opened for. Never another site's.
 */
function trustCertificate(target, base) {
  try { const t = new URL(target); return isLocalHost(t.hostname) || t.hostname === new URL(base).hostname; } catch { return false; }
}

/** What a link or window.open does: stay in the app, open the app's own popup (print, leaflet), or a site in a window of its own. */
function openKind(target, base) {
  if (target === "about:blank" || target === "" || target == null) return "popup";
  if (isAppUrl(target, base)) return "popup";
  try { const u = new URL(target); if (u.protocol === "http:" || u.protocol === "https:") return "site"; } catch { /* fall through */ }
  return "deny";   // file:, javascript:, custom schemes: never
}

/** A Windows .ico file holding PNG pictures (Windows Vista and later read them), each { size, png }. */
function icoFromPngs(list) {
  const head = Buffer.alloc(6 + 16 * list.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(list.length, 4);
  let offset = head.length;
  list.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...list.map((x) => x.png)]);
}

module.exports = { parseArgs, isAppUrl, isLocalHost, trustCertificate, openKind, icoFromPngs };
