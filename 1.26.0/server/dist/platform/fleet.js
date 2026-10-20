// The owner's fleet view (release 1.13, plan item 45): each hospital's main server reports its version, licence and
// health to the owner, so all customers are on one page. Never patient data: the report is the system health list
// (backups, disk, PCs, updates, licence, security), the version and the licence — nothing from the hospital's records.
//
//   Hospital side   the feature "fleet" (Admin → Features, off until the hospital turns it on) and an address the
//                   owner publishes in the signed control file (control.json fleetUrl, set with the repository
//                   variable FLEET_URL): the hospital cannot be pointed elsewhere by anyone but the owner. Sent every
//                   30 minutes with the control check. Each server makes a random key, sends it with its first report
//                   and signs every report with it (HMAC-SHA256), so nobody else can report as that hospital.
//   Owner side      on the owner's own server, receiving is turned on by the owner (Admin → Fleet). Reports land in
//                   fleet_hospitals, one row per machine code; "Forget" lets a hospital register again (a new PC).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import { healthReport } from "../modules/admin/health.js";
import { featureOn } from "../core/feature-gate.js";
import { settingStr } from "../core/settings.js";
import { now, nowIso, toLocalIso } from "../lib/time.js";
import { appVersion } from "./version.js";
import { licenceStatus } from "./licence.js";
import { nodeConfig } from "./node-config.js";
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]);
export const sign = (key, body) => createHmac("sha256", Buffer.from(key, "base64")).update(body).digest("base64");
/** The owner's address for reports, from the last signed control file obeyed (updater.ts), or null. */
export function fleetUrl() {
    const u = META("fleet_url");
    if (!u)
        return null;
    try {
        const p = new URL(u);
        // over the internet only https (the first report carries the hospital's key); http only inside a private network
        const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(p.hostname);
        return p.protocol === "https:" || (p.protocol === "http:" && local) ? p.toString() : null;
    }
    catch {
        return null;
    }
}
export function setFleetUrl(u) { SET("fleet_url", u ?? ""); }
/** What a hospital tells the owner. */
export async function fleetReport() {
    const lic = licenceStatus();
    const h = await healthReport();
    const since = toLocalIso(new Date(now().getTime() - 10 * 60_000));
    const nodes = db().get("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END), 0) AS online FROM nodes WHERE status = 'active'", [since]);
    return {
        v: 1, machine: lic.machineCode || null, hospital: settingStr("hospital.name"), version: appVersion(), at: nowIso(),
        licence: { state: lic.state, hospital: lic.hospital ?? null, pharmacyPcs: lic.pharmacyPcs ?? null, graceUntil: lic.graceUntil ?? null },
        pcs: { total: nodes?.n ?? 0, online: nodes?.online ?? 0 },
        health: { overall: h.overall, items: h.items.map((i) => ({ key: i.key, group: i.group, label: i.label, level: i.level, value: i.value })) },
    };
}
let last = null;
export const lastFleetReport = () => last;
/** Sends this hospital's report to the owner, when the hospital allows it and the owner has published an address. */
export async function sendFleetReport() {
    const url = fleetUrl();
    if (nodeConfig().role !== "server" || !featureOn("fleet") || !url)
        return;
    let key = META("fleet_key");
    if (!key) {
        key = randomBytes(32).toString("base64");
        SET("fleet_key", key);
    }
    const body = JSON.stringify(await fleetReport());
    const registered = META("fleet_registered") === url;
    const headers = { "content-type": "application/json", "x-hps-fleet-sig": sign(key, body) };
    if (!registered)
        headers["x-hps-fleet-key"] = key;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15_000);
    try {
        const r = await fetch(url, { method: "POST", headers, body, signal: c.signal });
        if (r.status === 401) {
            SET("fleet_registered", "");
            throw new Error("The owner's server asked this hospital to register again");
        }
        if (r.status === 429)
            throw new Error("The owner's server is not taking new hospitals now");
        if (!r.ok)
            throw new Error(`The owner's server answered ${r.status}`);
        SET("fleet_registered", url);
        last = { at: nowIso(), ok: true };
    }
    catch (e) {
        last = { at: nowIso(), ok: false, error: String(e?.message ?? e) };
    }
    finally {
        clearTimeout(t);
    }
}
/* ---------------- the owner's side ---------------- */
export const receivingOn = () => META("fleet_receive") === "1";
export function setReceiving(on) { SET("fleet_receive", on ? "1" : "0"); }
/** At most this many hospitals, and this many waiting for the owner to recognise them (a flood stops there). */
const MAX_HOSPITALS = 2000, MAX_WAITING = 50;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.round(v))) : null);
const LEVELS = ["ok", "warn", "danger", "info"];
const STATES = ["licensed", "grace", "unlicensed", "not_required"];
/** Only the fields the Fleet page shows, each the type and size it should be: a forged report is stored harmless. */
export function cleanReport(r) {
    const items = Array.isArray(r?.health?.items) ? r.health.items.slice(0, 60) : [];
    return {
        hospital: str(r?.hospital, 120), version: str(r?.version, 40), at: str(r?.at, 40),
        licence: { state: STATES.includes(r?.licence?.state) ? r.licence.state : null, hospital: str(r?.licence?.hospital, 120),
            pharmacyPcs: int(r?.licence?.pharmacyPcs), graceUntil: str(r?.licence?.graceUntil, 40) },
        pcs: { total: int(r?.pcs?.total) ?? 0, online: int(r?.pcs?.online) ?? 0 },
        health: { overall: LEVELS.includes(r?.health?.overall) ? r.health.overall : "info",
            items: items.map((i) => ({ key: str(i?.key, 40) ?? "", group: str(i?.group, 40) ?? "", label: str(i?.label, 120) ?? "",
                level: LEVELS.includes(i?.level) ? i.level : "info", value: str(i?.value, 300) ?? "" })) },
    };
}
/**
 * Takes a hospital's report: the first from a machine registers its key (and waits for the owner to recognise it);
 * every later one must be signed with that key. Returns the HTTP status to answer.
 */
export function receiveReport(raw, headers, ip) {
    if (!receivingOn())
        return 404;
    let r;
    try {
        r = JSON.parse(raw);
    }
    catch {
        return 400;
    }
    const machine = typeof r?.machine === "string" && /^[A-Z0-9-]{8,80}$/.test(r.machine) ? r.machine : null;
    const sig = typeof headers["x-hps-fleet-sig"] === "string" ? headers["x-hps-fleet-sig"] : "";
    if (!machine || !sig)
        return 400;
    const row = db().get("SELECT key FROM fleet_hospitals WHERE machine = ?", [machine]);
    const offered = typeof headers["x-hps-fleet-key"] === "string" ? headers["x-hps-fleet-key"] : "";
    const key = row?.key ?? offered;
    if (!key || !/^[A-Za-z0-9+/=]{40,64}$/.test(key))
        return 401; // unknown machine without a key: register first
    const want = Buffer.from(sign(key, raw)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got))
        return row ? 401 : 403;
    if (!row) {
        const n = db().get("SELECT COUNT(*) AS \"all\", COALESCE(SUM(approved = 0), 0) AS waiting FROM fleet_hospitals");
        if (n.all >= MAX_HOSPITALS || n.waiting >= MAX_WAITING)
            return 429;
    }
    const c = cleanReport(r);
    const now = nowIso();
    db().run(`INSERT INTO fleet_hospitals(machine, key, hospital, version, overall, report, ip, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(machine) DO UPDATE SET hospital=excluded.hospital, version=excluded.version, overall=excluded.overall, report=excluded.report, ip=excluded.ip, last_seen=excluded.last_seen`, [machine, key, c.hospital, c.version, c.health.overall, JSON.stringify(c), ip, now, now]);
    return row ? 200 : 201;
}
export function fleetList() {
    return db().all("SELECT machine, hospital, version, overall, report, ip, approved, first_seen AS firstSeen, last_seen AS lastSeen FROM fleet_hospitals ORDER BY approved, hospital COLLATE NOCASE, machine")
        .map(({ report, approved, ...h }) => {
        let r = null;
        try {
            r = cleanReport(JSON.parse(report));
        }
        catch { /* shown without details */ }
        return { ...h, approved: !!approved, licence: r?.licence ?? null, pcs: r?.pcs ?? null, items: r?.health.items ?? [] };
    });
}
export function forgetHospital(machine) { return db().run("DELETE FROM fleet_hospitals WHERE machine = ?", [machine]).changes > 0; }
export function approveHospital(machine) { return db().run("UPDATE fleet_hospitals SET approved = 1 WHERE machine = ?", [machine]).changes > 0; }
