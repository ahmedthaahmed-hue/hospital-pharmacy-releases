// What the app window decides, kept apart from Electron so it can be tested with plain Node (policy.test.cjs).
"use strict";

/**
 * The window's command line. Window mode (the Desktop shortcut): `--port 8080` or `--url http://host:port/`.
 * PDF mode (the server's direct printing, platform/printing.ts): `--print-pdf <page.html> --out <file.pdf>
 * --profile <folder>`. Chromium adds switches of its own; anything not ours is ignored.
 */
function parseArgs(argv) {
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
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

module.exports = { parseArgs, isAppUrl, isLocalHost, trustCertificate, openKind };
