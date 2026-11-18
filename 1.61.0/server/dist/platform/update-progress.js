// How far an update being installed on this PC has got (release 1.19), and which update was installed last. Every
// screen shows it — the sign-in, setup and locked screens too — through the public GET /api/local/update-progress:
// a bar that cannot be closed while the files download, are checked and staged, and the app restarts into them, then
// "Updated to …" once the new version answers. Nothing here can stop an update; it only reports it.
//
// Phases and their share of the bar: preparing (0–2 %), downloading the signed package (2–80 %), staging the checked
// files (80–95 %), restarting (95 %, then 100 % once the new version is up, shown by the screens). The time left
// (release 1.21) comes from how fast the bar has moved so far, plus the restart.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { nowIso } from "../lib/time.js";
import { appVersion, compareVersions } from "./version.js";
import { dataPath } from "./paths.js";
const SHARE = { preparing: [0, 2], downloading: [2, 80], staging: [80, 95], restarting: [95, 95] };
/** How long restarting into the new version takes, about (the screens count it down themselves once it restarts). */
export const RESTART_SECONDS = 20;
let current = null;
let startedMs = 0;
let failure = null;
function percentOf(p) {
    const [a, b] = SHARE[p.phase];
    const part = p.bytesTotal > 0 ? p.bytes / p.bytesTotal : p.filesTotal > 0 ? p.files / p.filesTotal : 0;
    return Math.round((a + (b - a) * Math.min(1, part)) * 10) / 10;
}
const set = (patch) => {
    if (!current)
        return;
    current = { ...current, ...patch };
    current.percent = percentOf(current);
};
/** An update to `to` starts here (it cannot be stopped once started; it either restarts into it or fails). */
export function beginUpdate(to, opts) {
    failure = null;
    startedMs = Date.now();
    current = { from: appVersion(), to, phase: "preparing", percent: 0, files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0, ...opts, startedAt: nowIso(), etaSeconds: null };
}
/** A phase starts: how many files and bytes it has to go through. */
export function updatePhase(phase, filesTotal, bytesTotal, version) {
    if (!current || (version && version !== current.to))
        return;
    set({ phase, files: 0, filesTotal, bytes: 0, bytesTotal });
}
/** One more file of the phase is done (`version`: only for the update in progress — a PC's download is shared). */
export function updateFileDone(bytes, version) {
    if (!current || (version && version !== current.to))
        return;
    set({ files: current.files + 1, bytes: current.bytes + bytes });
}
/** Staged: the app restarts into the new version a moment from now. */
export function updateRestarting() { set({ phase: "restarting", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 }); }
/** It could not be installed: the app keeps running the version it has. */
export function updateFailed(message) {
    if (current)
        failure = { to: current.to, message, at: nowIso() };
    current = null;
}
/* ---------------- the update installed last (kept in a file of this PC, not in the database copy) ---------------- */
const RUNNING = () => dataPath("running-version.json");
const LAST = () => dataPath("last-update.json");
function readJson(file) {
    try {
        return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    }
    catch {
        return null;
    }
}
/**
 * At start-up: a newer version than the one this PC ran last means an update was just installed — remembered with
 * its time, so the screens can say "Updated to …".
 */
export function noteStartedVersion(now = nowIso()) {
    const before = readJson(RUNNING())?.version;
    const v = appVersion();
    try {
        if (before && before !== v && compareVersions(v, before) > 0)
            writeFileSync(LAST(), JSON.stringify({ from: before, to: v, at: now }));
        if (before !== v)
            writeFileSync(RUNNING(), JSON.stringify({ version: v, since: now }));
    }
    catch { /* a read-only data folder: nothing to show */ }
}
export function lastUpdate() {
    const l = readJson(LAST());
    return l && l.to === appVersion() && typeof l.from === "string" && typeof l.at === "string" ? l : null;
}
/** About how long is left: the rest of the bar (to 95 %) at the pace so far, then the restart. */
function etaOf(p, now) {
    if (p.phase === "restarting")
        return RESTART_SECONDS;
    const elapsed = (now - startedMs) / 1000;
    if (p.percent < 3 || elapsed < 2)
        return null;
    return Math.max(1, Math.round((elapsed * Math.max(0, 95 - p.percent)) / p.percent + RESTART_SECONDS));
}
/** What the screens show (public). */
export function updateProgressReport(now = Date.now()) {
    return { version: appVersion(), progress: current && { ...current, etaSeconds: etaOf(current, now) }, failure, lastUpdate: lastUpdate() };
}
/** Tests: start from nothing. */
export function resetUpdateProgress() { current = null; failure = null; }
