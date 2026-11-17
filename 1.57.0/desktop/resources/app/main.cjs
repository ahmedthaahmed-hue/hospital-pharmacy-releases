// The app's own window (release 1.46, docs/DESKTOP.md). The installers carry a private copy of the Chromium engine
// (Electron) in desktop\: the Desktop shortcut opens the screens in it, so a PC needs no web browser — none is
// installed, and one that is there is not used. The same program makes the PDFs that direct printing sends to the
// printer (platform/printing.ts), so that needs no browser either.
"use strict";
const { app, BrowserWindow, Menu, dialog } = require("electron");
const { existsSync, readFileSync: readText, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { parseArgs, isAppUrl, trustCertificate, openKind, icoFromPngs, clearBackground, contentBox } = require("./policy.cjs");

let opts;
try { opts = parseArgs(process.argv.slice(1)); }
catch (e) { dialog.showErrorBox("Hospital Pharmacy", String(e.message || e)); app.exit(2); }

// (1.56) the hospital's logo as an icon, when there is one (icons\current.txt names it, platform/app-icon.ts), else the
// system's own
const ICON = (() => {
  try {
    const f = readText(join(__dirname, "icons", "current.txt"), "utf8").trim();
    if (f && /^[\w.-]+\.ico$/.test(f) && existsSync(join(__dirname, "icons", f))) return join(__dirname, "icons", f);
  } catch { /* none */ }
  return join(__dirname, "icon.ico");
})();
app.setAppUserModelId("HospitalPharmacy.Window");

if (opts?.mode === "pdf") printPdf(opts);
else if (opts?.mode === "icon") makeIcon(opts);
else if (opts) openWindow(opts.base);

/* ---------------- PDF mode: lay out one page and save it as a PDF, with no window ---------------- */

function printPdf({ page, out, profile }) {
  // runs as SYSTEM from the server (no desktop, no GPU): a profile of its own, software drawing, no sandbox
  if (profile) app.setPath("userData", profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  const timer = setTimeout(() => { console.error("the page did not finish in time"); app.exit(3); }, 50_000);
  // the page's stylesheets and fonts come from this PC's server, whose certificate it made itself
  app.on("certificate-error", (e, _wc, url, _err, _cert, cb) => { e.preventDefault(); cb(trustCertificate(url, "https://localhost/")); });
  app.on("window-all-closed", () => { /* stay until the PDF is written */ });
  app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
    await w.loadURL(pathToFileURL(page).href);
    // wait for the fonts (the Arabic label font) and pictures (barcodes, the logo), as Edge's virtual-time budget did
    await w.webContents.executeJavaScript(`Promise.race([Promise.all([document.fonts.ready,
      ...Array.from(document.images).filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))]),
      new Promise(r => setTimeout(r, 4000))]).then(() => new Promise(r => setTimeout(r, 150)))`, true);
    const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    writeFileSync(out, pdf);
    clearTimeout(timer);
    app.exit(0);
  }).catch((e) => { console.error(String(e && e.stack || e)); app.exit(1); });
}

/* ---------------- icon mode (1.50): the hospital's logo as the shortcuts' and the window's icon ---------------- */

function makeIcon({ image, out, profile }) {
  if (profile) app.setPath("userData", profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  const timer = setTimeout(() => { console.error("the picture did not load in time"); app.exit(3); }, 30_000);
  app.on("window-all-closed", () => { /* stay until the icon is written */ });
  app.whenReady().then(async () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(image, "utf8").trim();   // the logo as the hospital saved it: a data: address
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(src)) throw new Error("not a picture");
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
    await w.loadURL("data:text/html;charset=utf-8,<!doctype html><title>icon</title>");
    // (1.56) its background made see-through and its empty margins cut away first (policy.cjs), then drawn square on
    // transparent, the logo as large as it fits, at each size Windows asks for
    const pngs = await w.webContents.executeJavaScript(`(async () => {
      const clearBackground = ${clearBackground.toString()};
      const contentBox = ${contentBox.toString()};
      const pic = new Image(); pic.src = ${JSON.stringify(src)}; await pic.decode();
      const pw = pic.naturalWidth || 512, ph = pic.naturalHeight || 512, k0 = Math.min(1, 512 / Math.max(pw, ph));
      const big = document.createElement("canvas"); big.width = Math.max(1, Math.round(pw * k0)); big.height = Math.max(1, Math.round(ph * k0));
      const bg = big.getContext("2d", { willReadFrequently: true }); bg.drawImage(pic, 0, 0, big.width, big.height);
      const px = bg.getImageData(0, 0, big.width, big.height);
      if (clearBackground(px)) bg.putImageData(px, 0, 0);
      const box = contentBox(px) || { x: 0, y: 0, w: big.width, h: big.height };
      const img = { naturalWidth: box.w, naturalHeight: box.h };
      return [256, 48, 32, 16].map((n) => {
        const c = document.createElement("canvas"); c.width = c.height = n;
        const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
        const k = Math.min(n / img.naturalWidth, n / img.naturalHeight), iw = img.naturalWidth * k, ih = img.naturalHeight * k;
        g.drawImage(big, box.x, box.y, box.w, box.h, (n - iw) / 2, (n - ih) / 2, iw, ih);
        return [n, c.toDataURL("image/png").split(",")[1]];
      });
    })()`, true);
    writeFileSync(out, icoFromPngs(pngs.map(([size, b]) => ({ size, png: Buffer.from(b, "base64") }))));
    clearTimeout(timer);
    app.exit(0);
  }).catch((e) => { console.error(String(e && e.stack || e)); app.exit(1); });
}

/* ---------------- window mode ---------------- */

function startingPage(base, again) {
  const en = again ? "Reconnecting to Hospital Pharmacy…" : "Starting Hospital Pharmacy…";
  const ar = again ? "جارٍ إعادة الاتصال…" : "جارٍ التشغيل…";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hospital Pharmacy</title><style>
    html,body{height:100%;margin:0;font:15px "Segoe UI",system-ui,sans-serif;background:#edf0f7;color:#0b1533}
    @media (prefers-color-scheme:dark){html,body{background:#060b1a;color:#e6ebf7}}
    main{height:100%;display:grid;place-content:center;text-align:center;gap:6px}
    small{opacity:.65}</style></head><body><main><div>${en}</div><div dir="rtl">${ar}</div>
    <small>${base.replace(/\/$/, "")}</small></main></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

async function answers(base) {
  try { const r = await fetch(base + "api/local/info", { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}

function openWindow(base) {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let main = null;
  app.on("second-instance", () => { if (main) { if (main.isMinimized()) main.restore(); main.focus(); } });
  app.on("window-all-closed", () => app.quit());
  // the app's own certificate (a main server opened by its address); any other site's must be valid
  app.on("certificate-error", (e, _wc, url, _err, _cert, cb) => { if (trustCertificate(url, base)) { e.preventDefault(); cb(true); } else cb(false); });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(appMenu());
    // the camera (barcodes, prescription photos), the clipboard and notifications, for the app only
    const ses = require("electron").session.defaultSession;
    ses.setPermissionRequestHandler((wc, _perm, cb, details) => cb(isAppUrl(details.requestingUrl || wc.getURL(), base)));
    ses.setPermissionCheckHandler((_wc, _perm, origin) => isAppUrl(origin || "", base));

    main = makeWindow(base, { width: 1440, height: 900 });
    main.maximize();
    main.show();
    connect(main, base, false);
  });
}

/** Show the starting page until the server answers, then the app (again after the server restarts for an update). */
async function connect(win, base, again) {
  if (win.isDestroyed()) return;
  await win.loadURL(startingPage(base, again)).catch(() => {});
  while (!win.isDestroyed() && !(await answers(base))) await new Promise((r) => setTimeout(r, 1500));
  if (!win.isDestroyed()) win.loadURL(base).catch(() => {});
}

function makeWindow(base, size, parent) {
  const win = new BrowserWindow({
    ...size, show: false, icon: ICON, title: "Hospital Pharmacy", autoHideMenuBar: true, backgroundColor: "#edf0f7",
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  const wc = win.webContents;
  const isMain = !parent;
  // links: the app's own popups (printing, leaflets) open as app windows; another site opens in a window of its
  // own (there may be no browser to send it to); anything else (files, other programs) is refused
  wc.setWindowOpenHandler(({ url }) => {
    const kind = openKind(url, base);
    if (kind === "deny") return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, width: 1100, height: 800,
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false } } };
  });
  wc.on("did-create-window", (child) => wireChild(child, base));
  if (isMain) {
    // the main window stays on the app: a link to another site opens beside it
    wc.on("will-navigate", (e, url) => {
      if (url.startsWith("data:") || isAppUrl(url, base)) return;
      e.preventDefault();
      if (openKind(url, base) === "site") { const w = makeWindow(base, { width: 1100, height: 800 }, win); w.show(); w.loadURL(url); }
    });
    // the server went away (an update restarts it, or the PC was starting): wait for it, then come back
    wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && isAppUrl(url, base)) connect(win, base, true);
    });
    wc.on("render-process-gone", () => connect(win, base, true));
    wc.on("context-menu", (_e, p) => editMenu(p)?.popup({ window: win }));
  } else wireChild(win, base);
  return win;
}

function wireChild(win, base) {
  win.setMenuBarVisibility(false);
  win.webContents.on("context-menu", (_e, p) => editMenu(p)?.popup({ window: win }));
  win.webContents.setWindowOpenHandler(({ url }) => (openKind(url, base) === "deny" ? { action: "deny" } : { action: "allow" }));
}

/** Right click: cut, copy, paste where they make sense (Chromium has no menu of its own here). */
function editMenu(p) {
  const items = [];
  if (p.isEditable) items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" });
  else if (p.selectionText && p.selectionText.trim()) items.push({ role: "copy" }, { role: "selectAll" });
  else return null;
  return Menu.buildFromTemplate(items);
}

/**
 * The menu bar is hidden (Alt shows it); its keys work: F5 reload, Ctrl +/- zoom, F11 full screen. Ctrl+P and the
 * Alt+letter keys stay the app's own (docs: keyboard shortcuts), so the menu takes neither.
 */
function appMenu() {
  return Menu.buildFromTemplate([
    { label: "File", submenu: [{ label: "Print…", click: (_m, w) => w?.webContents.print() }, { type: "separator" }, { role: "close" }, { role: "quit", label: "Exit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload", accelerator: "F5" }, { role: "forceReload" }, { type: "separator" },
      { role: "zoomIn", accelerator: "CmdOrCtrl+=" }, { role: "zoomOut" }, { role: "resetZoom" }, { type: "separator" },
      { role: "togglefullscreen", accelerator: "F11" }, { role: "toggleDevTools", accelerator: "CmdOrCtrl+Shift+I" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { label: "Back", accelerator: "Alt+Left", click: (_m, w) => w?.webContents.navigationHistory.goBack() },
      { label: "Forward", accelerator: "Alt+Right", click: (_m, w) => w?.webContents.navigationHistory.goForward() }] },
  ]);
}
