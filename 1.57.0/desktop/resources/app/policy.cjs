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

/* (1.56) The logo's background made see-through and its empty margins cut away before it becomes the icon: the same as
   the screens do (web/src/lib/logo-image.ts, which has the tests of the same steps). Plain functions, so main.cjs can
   hand their text to the page that draws the icon. */

/**
 * Makes the picture's background see-through, in place ({ data, width, height } as a canvas gives it): when its edge
 * is (mostly) one colour, every pixel of that colour joined to the edge is cleared (the same colour inside the logo is
 * kept), and the pixels that blend into it are faded. A picture whose edge is see-through or many-coloured is left.
 */
function clearBackground(px, tolerance = 48) {
  const { data, width: w, height: h } = px;
  if (w < 3 || h < 3) return false;
  const edge = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  // the edge's colour: the most common among its opaque pixels (in steps of 16)
  const counts = new Map();
  let opaque = 0;
  for (const i of edge) {
    if (data[i * 4 + 3] < 200) continue;
    opaque++;
    const k = ((data[i * 4] >> 4) << 8) | ((data[i * 4 + 1] >> 4) << 4) | (data[i * 4 + 2] >> 4);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (opaque < edge.length * 0.5) return false;                       // already see-through around it
  let best = 0, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  if (bestN < opaque * 0.6) return false;                             // no one background colour: a photo
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of edge) {
    if (data[i * 4 + 3] < 200) continue;
    const k = ((data[i * 4] >> 4) << 8) | ((data[i * 4 + 1] >> 4) << 4) | (data[i * 4 + 2] >> 4);
    if (k !== best) continue;
    r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const dist = (i) => Math.hypot(data[i * 4] - r, data[i * 4 + 1] - g, data[i * 4 + 2] - b);
  const gone = new Uint8Array(w * h);
  const stack = [];
  for (const i of edge) if (dist(i) <= tolerance) { gone[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || gone[j] || dist(j) > tolerance) continue;
      gone[j] = 1; stack.push(j);
    }
  }
  let changed = false;
  for (let i = 0; i < w * h; i++) {
    if (gone[i]) { if (data[i * 4 + 3]) { data[i * 4 + 3] = 0; changed = true; } continue; }
    // a pixel beside the cleared background that is close to its colour: faded, for a soft edge
    const x = i % w;
    const near = (x > 0 && gone[i - 1]) || (x < w - 1 && gone[i + 1]) || (i >= w && gone[i - w]) || (i < w * (h - 1) && gone[i + w]);
    if (!near) continue;
    const d = dist(i);
    if (d < tolerance * 2) { data[i * 4 + 3] = Math.round(data[i * 4 + 3] * Math.min(1, (d - tolerance) / tolerance)); changed = true; }
  }
  return changed;
}

/** The part of the picture that is not see-through (a small margin kept), or null when it is all see-through. */
function contentBox(px, margin = 0.02) {
  const { data, width: w, height: h } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] <= 8) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * margin);
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}


module.exports = { parseArgs, isAppUrl, isLocalHost, trustCertificate, openKind, icoFromPngs, clearBackground, contentBox };
