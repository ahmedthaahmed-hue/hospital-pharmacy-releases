// Downloads an approved update, checks every file against the signed manifest, stages it, and asks the launcher to
// restart into it. Also holds the "locked" state (the remote off switch): once received it is remembered, so a killed
// PC stays off even with no internet. Nothing here deletes the database.
import { createHash, randomUUID } from "node:crypto";
import { setFleetUrl } from "./fleet.js";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "../db/index.js";
import { nowIso } from "../lib/time.js";
import { appVersion, compareVersions } from "./version.js";
import { licenceStatus } from "./licence.js";
import { nodeConfig } from "./node-config.js";
import { dataPath } from "./paths.js";
import { FetchError, fetchControl, fetchManifestSigned, parseSignedManifest, releasesBase } from "./releases.js";
import { beginUpdate, updateFailed, updateFileDone, updatePhase, updateRestarting } from "./update-progress.js";
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]);
/**
 * Whether this PC is locked: the owner's off switch / version floor / the main server's lock (stored), or else no
 * valid machine licence (computed, see licence.ts).
 */
export function lockState() {
    const stored = storedLock();
    if (stored.locked)
        return stored;
    const l = licenceStatus();
    return l.state === "unlicensed" ? { locked: true, message: l.message, since: null, reason: "unlicensed" } : stored;
}
function storedLock() {
    const v = META("lock");
    const none = { locked: false, message: null, since: null, reason: null };
    if (!v)
        return none;
    try {
        const o = JSON.parse(v);
        return { locked: !!o.locked, message: o.message ?? null, since: o.since ?? null, reason: o.locked ? (o.reason ?? "killed") : null };
    }
    catch {
        return none;
    }
}
/** Lock or unlock this PC. Only ever set from a verified control file (main server) or the main server's heartbeat. */
export function setLock(locked, message, reason = "killed") {
    const cur = storedLock();
    if (locked === cur.locked) {
        if (locked && ((message && message !== cur.message) || reason !== cur.reason))
            SET("lock", JSON.stringify({ locked, message: message ?? cur.message, since: cur.since, reason }));
        return;
    }
    SET("lock", JSON.stringify({ locked, message, since: locked ? nowIso() : null, reason: locked ? reason : null }));
    db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), locked ? "system.locked" : "system.unlocked", "system", JSON.stringify({ message, reason: locked ? reason : undefined })]);
}
let lastControl = null;
let lastCheckAt = null;
let lastError = null;
let lastResult = null;
export function updateStatus() {
    const lock = lockState();
    return {
        version: appVersion(), latestVersion: lastControl?.latestVersion ?? null,
        updateAvailable: !!lastControl && compareVersions(lastControl.latestVersion, appVersion()) > 0,
        killed: lock.locked, lockMessage: lock.message, lockedSince: lock.since, lockReason: lock.reason,
        lastCheckAt, lastError, lastResult, message: lastControl?.message ?? null, releasesBase: releasesBase(),
    };
}
/** Check the signed control file (main server, needs internet). Applies the off switch and remembers the latest version. */
export async function checkControl() {
    try {
        const c = await fetchControl();
        // The owner signs releases' manifests and licences with the same key. Only a real control file (sign-release.mjs
        // always writes latestVersion and publishedAt) is obeyed as one: a licence served as control.json has neither and
        // would otherwise clear the off switch, and a file without publishedAt would escape the check below.
        if (typeof c?.latestVersion !== "string" || typeof c.publishedAt !== "string" || !c.publishedAt)
            throw new Error("The update server's control file is not a control file — ignoring it.");
        // A signed control file is obeyed only if it is not older than the last one obeyed: an old signed file served again
        // (an old "off", or an old "on" after the owner turned the system off) must not undo the owner's latest command.
        const seen = META("control_published_at");
        if (c.publishedAt && seen && c.publishedAt < seen)
            throw new Error("The update server sent an older control file than the last one — ignoring it.");
        if (c.publishedAt)
            SET("control_published_at", c.publishedAt);
        // where the owner takes the hospitals' reports (platform/fleet.ts): set only by the owner's signed file
        setFleetUrl(typeof c.fleetUrl === "string" ? c.fleetUrl : undefined);
        lastControl = c;
        lastCheckAt = nowIso();
        lastError = null;
        lastResult = compareVersions(c.latestVersion, appVersion()) > 0 ? "available" : "up_to_date";
        const tooOld = c.minVersion && compareVersions(appVersion(), c.minVersion) < 0;
        if (c.killed)
            setLock(true, c.message ?? "The system has been turned off by its owner.", "killed");
        else if (tooOld)
            setLock(true, c.message ?? "This version is no longer allowed. Please update.", "too_old");
        // The owner cleared the off switch, or this version is allowed again (after updating): unlock. On the main server a
        // lock only ever comes from this file, so the latest file decides whatever message the lock carried.
        else if (storedLock().locked)
            setLock(false, null);
    }
    catch (e) {
        lastCheckAt = nowIso();
        // nothing published yet (the releases repo has no control file): not a failure, there is simply no update
        if (e instanceof FetchError && e.status === 404) {
            lastResult = "none_published";
            lastError = null;
        }
        else {
            lastResult = "failed";
            lastError = String(e?.message ?? e);
        }
    }
    return updateStatus();
}
/* ---------------- updating by itself (main server) ---------------- */
/** The exit code that makes the launcher swap in a staged update and relaunch (update-routes RESTART_EXIT_CODE). */
const RESTART_EXIT_CODE = 69;
/** How long after staging the app exits into the new version: the screens see "Restarting…" first. */
export const RESTART_DELAY_MS = 1500;
/** Install only after this long with no change saved by anyone, so the restart never lands in the middle of work. */
export const AUTO_UPDATE_QUIET_MS = 5 * 60_000;
const AUTO_UPDATE_RETRY_MS = 30 * 60_000;
let lastActivityAt = Date.now(); // wait a while after start-up too
let autoTriedAt = 0;
/** Someone saved a change here (app.ts, for each signed-in write): an automatic update waits for a quiet spell. */
export function noteActivity() { lastActivityAt = Date.now(); }
/**
 * Why the main server would not install the latest version by itself right now, or null when it would: it is the main
 * server, run by the launcher (which swaps the files in), a newer version is published, the owner has not turned the
 * system off, nobody has saved anything for a few minutes, and the last attempt was not just now.
 */
export function autoUpdateBlocker(now = Date.now()) {
    if (process.env.HPS_LAUNCHER !== "1")
        return "not run by the launcher";
    if (nodeConfig().role !== "server")
        return "not the main server";
    const s = updateStatus();
    if (!s.updateAvailable || !s.latestVersion)
        return "no newer version";
    const lock = lockState();
    if (lock.locked && lock.reason !== "too_old")
        return "locked"; // a version the owner no longer allows: updating is the cure
    if (now - lastActivityAt < AUTO_UPDATE_QUIET_MS)
        return "in use";
    if (now - autoTriedAt < AUTO_UPDATE_RETRY_MS)
        return "tried recently";
    return null;
}
/**
 * The main server installs a newer version by itself (checked every few minutes, services.ts): downloads it, checks
 * every file against the owner's signature, stages it and restarts into it. Pharmacy PCs then follow it on their own
 * (pharmacy-agent.ts). Returns whether an update was staged (the process exits a moment later).
 */
export async function autoUpdate() {
    if (autoUpdateBlocker())
        return false;
    autoTriedAt = Date.now();
    const from = appVersion(), to = updateStatus().latestVersion;
    try {
        const r = await downloadAndStage(to, { auto: true });
        db().run("INSERT INTO audit_log(at, action, entity, details) VALUES (?,?,?,?)", [nowIso(), "system.update.apply", "system", JSON.stringify({ from, to, files: r.files, auto: true })]);
        setTimeout(() => process.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
        return true;
    }
    catch (e) {
        lastError = `Installing ${to} by itself failed: ${String(e?.message ?? e)} (tried again in 30 minutes)`;
        return false;
    }
}
/** Learn the lock state from the main server (pharmacy PC, via the sync heartbeat). */
export function applyRemoteLock(killed, message) { setLock(killed, message, "remote"); }
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
/** A manifest path that stays inside the install folder. */
export function safeReleasePath(p) {
    return !!p && !p.includes("..") && !p.startsWith("/") && !p.includes("\\") && !p.includes(":") && !p.includes("\0");
}
/**
 * Write every file of a verified manifest into `dir`, getting each with getFile and checking it against its signed
 * checksum. Anything that does not match fails the whole update.
 */
async function fillVerified(dir, manifest, getFile, onFile) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of manifest.files) {
        if (!safeReleasePath(f.path))
            throw new Error(`Unsafe path in update: ${f.path}`);
        const buf = await getFile(f.path);
        if (createHash("sha256").update(buf).digest("hex") !== f.sha256)
            throw new Error(`Update file ${f.path} failed its checksum — refusing the update.`);
        const dest = join(dir, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        onFile?.(buf.length);
    }
}
const bytesOf = (m) => m.files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
/** Tell the launcher a verified update is staged: it swaps update-staging/ into the install and relaunches. */
function markReady(version) {
    writeFileSync(dataPath("update-ready.json"), JSON.stringify({ version, stagedAt: nowIso(), from: appVersion() }));
}
// One download per version at a time: every pharmacy PC asks for the package as soon as the main server has updated,
// and two downloads into the same folder would delete each other's files and leave a cache marked complete without them.
const caching = new Map();
export function ensureReleaseCached(version) {
    let p = caching.get(version);
    if (!p) {
        p = cacheRelease(version).finally(() => caching.delete(version));
        caching.set(version, p);
    }
    return p;
}
async function cacheRelease(version) {
    if (!VERSION_RE.test(version))
        throw new Error("Invalid version");
    const root = dataPath("release-cache");
    const dir = join(root, version);
    if (existsSync(join(dir, ".complete"))) {
        const text = readFileSync(join(dir, "manifest.json"), "utf8"), sig = readFileSync(join(dir, "manifest.json.sig"), "utf8");
        return { version, dir, manifest: parseSignedManifest(text, sig, version), text, sig: sig.trim() };
    }
    const { manifest, text, sig } = await fetchManifestSigned(version);
    const base = `${releasesBase()}/${encodeURIComponent(version)}`;
    const part = `${dir}.part-${randomUUID()}`;
    // (the update being installed shows this download on its bar; a package fetched for the pharmacy PCs does not)
    updatePhase("downloading", manifest.files.length, bytesOf(manifest), version);
    try {
        await fillVerified(join(part, "files"), manifest, async (p) => {
            // a stalled download must not hold every pharmacy PC's update behind it for ever
            const r = await fetch(`${base}/${p.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store", signal: AbortSignal.timeout(5 * 60_000) });
            if (!r.ok)
                throw new Error(`Could not download ${p} (${r.status})`);
            return Buffer.from(await r.arrayBuffer());
        }, (bytes) => updateFileDone(bytes, version));
        writeFileSync(join(part, "manifest.json"), text);
        writeFileSync(join(part, "manifest.json.sig"), sig);
        rmSync(dir, { recursive: true, force: true });
        renameSync(part, dir);
        writeFileSync(join(dir, ".complete"), nowIso());
    }
    finally {
        rmSync(part, { recursive: true, force: true });
    }
    // keep only this version's package (and leave any other version still downloading alone)
    for (const d of readdirSync(root))
        if (d !== version && ![...caching.keys()].some((v) => d === v || d.startsWith(`${v}.part-`)))
            rmSync(join(root, d), { recursive: true, force: true });
    return { version, dir, manifest, text, sig };
}
/** A file of a cached package (only files its signed manifest lists). */
export function cachedReleaseFile(rel, path) {
    return safeReleasePath(path) && rel.manifest.files.some((f) => f.path === path) ? join(rel.dir, "files", path) : null;
}
/**
 * Main server: download the given version, verify it against the signed manifest, stage it next to the install, and
 * signal the launcher to restart into it. Returns after staging; the caller exits with code 69 so the launcher swaps
 * and relaunches. The package stays cached for the pharmacy PCs.
 */
let staging = false;
export async function downloadAndStage(version, opts = {}) {
    // Two installs at once (a double click, two admins) would empty and fill the same staging folder over each other,
    // and the first to finish would restart into a half-written one.
    // Once staged it stays "busy": the app is about to restart into it.
    if (staging)
        throw new Error("An update is already being installed");
    staging = true;
    beginUpdate(version, { auto: !!opts.auto, source: "internet" });
    try {
        const rel = await ensureReleaseCached(version);
        const dir = dataPath("update-staging");
        updatePhase("staging", rel.manifest.files.length, bytesOf(rel.manifest));
        await fillVerified(dir, rel.manifest, async (p) => readFileSync(join(rel.dir, "files", p)), (bytes) => updateFileDone(bytes));
        markReady(version);
        updateRestarting();
        return { staged: dir, files: rel.manifest.files.length };
    }
    catch (e) {
        staging = false;
        updateFailed(String(e?.message ?? e));
        throw e;
    }
}
/**
 * Pharmacy PC: stage the main server's version from the package it hands out. The manifest must carry the owner's
 * signature (checked here with the built-in key), so a main server can pass on only releases the owner signed.
 */
export async function stageFromServer(version, manifestText, sig, getFile) {
    if (!VERSION_RE.test(version))
        throw new Error("Invalid version");
    if (compareVersions(version, appVersion()) <= 0)
        throw new Error(`Already on ${appVersion()}`);
    const manifest = parseSignedManifest(manifestText, sig, version);
    const staging = dataPath("update-staging");
    // (the files come straight from the main server into the staging folder: one phase on the bar)
    updatePhase("downloading", manifest.files.length, bytesOf(manifest));
    await fillVerified(staging, manifest, getFile, (bytes) => updateFileDone(bytes));
    markReady(version);
    updateRestarting();
    return { staged: staging, files: manifest.files.length };
}
