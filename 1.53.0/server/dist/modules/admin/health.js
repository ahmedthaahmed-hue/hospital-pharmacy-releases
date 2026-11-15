// System health (release 1.8): one page that says whether the system is well, for the admin who looks after it —
// each line green, amber or red with what to do. The database, disk space, backups (made, checked, copied), pharmacy
// PCs and their sync, updates, the licence, the clock, HTTPS and two-step sign-in for administrators.
import { statfsSync, statSync } from "node:fs";
import { featureOn } from "../../core/feature-gate.js";
import { relayContact, relayUrl } from "../../platform/phone.js";
import { labelFontStatus } from "../../platform/label-font.js";
import { dirname, resolve } from "node:path";
import { db } from "../../db/index.js";
import { nowIso, toLocalIso } from "../../lib/time.js";
import { nodeConfig } from "../../platform/node-config.js";
import { appVersion } from "../../platform/version.js";
import { updateStatus } from "../../platform/updater.js";
import { licenceStatus } from "../../platform/licence.js";
import { accessOf } from "../../auth/access.js";
import { backupDir, intervalMs, listBackups } from "./backup.js";
import { copyDir, dirExists, recentChecks } from "./backup-check.js";
import { settingBool } from "../../core/settings.js";
import { tlsInfo } from "../../platform/tls-state.js";
const GB = 1024 ** 3;
const fmtBytes = (n) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const hoursAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 3600_000;
function freeSpace(p) { try {
    const s = statfsSync(p);
    return s.bavail * s.bsize;
}
catch {
    return null;
} }
export async function healthReport() {
    const d = db();
    const role = nodeConfig().role;
    const items = [];
    const add = (i) => items.push(i);
    // ---- the app
    add({ key: "version", group: "System", label: "Version", level: "info", value: `${appVersion()} (${role === "pharmacy" ? "pharmacy PC" : "main server"}), running ${Math.round(process.uptime() / 3600)} h` });
    const rss = process.memoryUsage().rss;
    add({ key: "memory", group: "System", label: "Memory used", level: rss > 1.5 * GB ? "warn" : "ok", value: fmtBytes(rss), hint: rss > 1.5 * GB ? "Restart the app at a quiet time" : undefined });
    add({ key: "clock", group: "System", label: "Clock and time zone", level: process.env.TZ && process.env.TZ !== "Africa/Cairo" ? "warn" : "ok",
        value: `${toLocalIso(new Date()).replace("T", " ")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` });
    // ---- database and disk
    if (d.file !== ":memory:") {
        const file = resolve(process.cwd(), d.file);
        const size = (p) => { try {
            return statSync(p).size;
        }
        catch {
            return 0;
        } };
        add({ key: "db", group: "Database", label: "Database size", level: "ok", value: `${fmtBytes(size(file))} (+ ${fmtBytes(size(`${file}-wal`))} log)` });
        const free = freeSpace(dirname(file));
        if (free != null)
            add({ key: "disk", group: "Database", label: "Free space on the data disk", level: free < 2 * GB ? "danger" : free < 10 * GB ? "warn" : "ok",
                value: fmtBytes(free), hint: free < 10 * GB ? "Free some space: the database and its backups grow every day" : undefined });
    }
    const integrity = d.get("SELECT value FROM schema_meta WHERE key = 'health.integrity'")?.value;
    if (integrity) {
        const j = JSON.parse(integrity);
        add({ key: "integrity", group: "Database", label: "Database check", level: j.result === "ok" ? "ok" : "danger", value: `${j.result === "ok" ? "No damage found" : j.result.slice(0, 120)} (${j.at.replace("T", " ").slice(0, 16)})`,
            hint: j.result === "ok" ? undefined : "Restore the newest checked backup (Admin → Backups) and contact support" });
    }
    else
        add({ key: "integrity", group: "Database", label: "Database check", level: "info", value: "Not checked yet — press Check the database" });
    // ---- backups (main server)
    if (role !== "pharmacy" && d.file !== ":memory:") {
        const last = listBackups()[0];
        const every = intervalMs() / 3600_000;
        add({ key: "backup", group: "Backups", label: "Newest backup", level: !last ? "danger" : hoursAgo(last.at) > every * 3 ? "danger" : hoursAgo(last.at) > every * 1.5 ? "warn" : "ok",
            value: last ? `${last.at.replace("T", " ").slice(0, 16)} (${fmtBytes(last.size)})` : "None", hint: !last ? "Make a backup now in Admin → Backups" : undefined });
        const free = freeSpace(backupDir());
        if (free != null)
            add({ key: "backup_disk", group: "Backups", label: "Free space for backups", level: free < 2 * GB ? "danger" : free < 5 * GB ? "warn" : "ok", value: fmtBytes(free) });
        const check = recentChecks(1)[0];
        add({ key: "backup_check", group: "Backups", label: "Last backup check", level: !check ? "warn" : check.ok ? "ok" : "danger",
            value: check ? `${check.ok ? "Opened and checked" : check.error ?? "Failed"} — ${check.file} (${check.at.replace("T", " ").slice(0, 16)})` : "No backup checked yet",
            hint: check && !check.ok ? "Look at Admin → Backups: a backup that cannot be opened would not restore" : undefined });
        const cdir = copyDir();
        if (!cdir)
            add({ key: "backup_copy", group: "Backups", label: "Copy to a second place", level: "warn", value: "Not set", hint: "Set a USB disk or a shared folder on another PC in Settings → Backups: a backup on the same disk is lost with it" });
        else {
            const lastCopy = d.get("SELECT at, copy_ok, error FROM backup_checks WHERE copied_to IS NOT NULL OR (copy_ok IS NULL AND error LIKE 'Could not copy%') ORDER BY id DESC LIMIT 1");
            const there = await dirExists(cdir);
            add({ key: "backup_copy", group: "Backups", label: "Copy to a second place", level: !there ? "danger" : lastCopy && !lastCopy.copy_ok ? "danger" : "ok",
                value: `${cdir}${there ? "" : " — not reachable"}${lastCopy ? ` · last copy ${lastCopy.copy_ok ? "OK" : "failed"} ${String(lastCopy.at).replace("T", " ").slice(0, 16)}` : ""}`,
                hint: !there ? "Plug in the backup disk, or check the shared folder and its permissions" : undefined });
        }
        const test = d.get("SELECT at, ok, file FROM backup_checks WHERE kind = 'restore_test' ORDER BY id DESC LIMIT 1");
        add({ key: "restore_test", group: "Backups", label: "Last restore test", level: !test ? "warn" : !test.ok ? "danger" : hoursAgo(test.at) > 24 * 31 ? "warn" : "ok",
            value: test ? `${test.ok ? "Passed" : "Failed"} — ${test.file} (${String(test.at).slice(0, 10)})` : "Never", hint: !test || hoursAgo(test.at) > 24 * 31 ? "Test a restore once a month (Admin → Backups)" : undefined });
    }
    // ---- pharmacy PCs (main server)
    if (role === "server") {
        const nodes = d.all("SELECT id, name, status, last_seen_at, pending_ops, failed_ops, version, offline_since, tls FROM nodes ORDER BY name");
        for (const n of nodes) {
            if (n.status !== "active")
                continue;
            const ago = n.last_seen_at ? hoursAgo(n.last_seen_at) * 60 : Infinity;
            const level = ago > 60 ? "danger" : ago > 5 || n.failed_ops > 0 ? "warn" : "ok";
            add({ key: `node_${n.id}`, group: "Pharmacy PCs", label: n.name, level,
                value: `${ago <= 5 ? "Online" : n.last_seen_at ? `Last seen ${String(n.last_seen_at).replace("T", " ").slice(0, 16)}` : "Never connected"} · ${n.version ?? "?"}`
                    + `${n.pending_ops ? ` · ${n.pending_ops} waiting` : ""}${n.failed_ops ? ` · ${n.failed_ops} failed` : ""}${n.tls ? " · encrypted" : " · not encrypted yet"}`,
                hint: ago > 60 ? "Check the PC is on and on the network" : n.failed_ops ? "See Admin → Network → Sync problems" : undefined });
        }
        if (!nodes.length)
            add({ key: "nodes", group: "Pharmacy PCs", label: "Pharmacy PCs", level: "info", value: "None connected" });
        const open = d.get("SELECT COUNT(*) n FROM sync_issues WHERE resolved_at IS NULL")?.n ?? 0;
        add({ key: "sync_issues", group: "Pharmacy PCs", label: "Sync problems", level: open ? "warn" : "ok", value: open ? `${open} not resolved` : "None", hint: open ? "Admin → Network → Sync problems" : undefined });
    }
    // ---- (1.52) ready for work: the phone relay, and the catalogue and kits filled in
    if (role === "server") {
        if (featureOn("phone_app")) {
            const url = relayUrl();
            const phones = d.get("SELECT COUNT(*) n FROM phone_devices WHERE status = 'active'")?.n ?? 0;
            add({ key: "phone_relay", group: "Phones", label: "Phone relay", level: !url ? "warn" : relayContact.ok ? "ok" : relayContact.at ? "danger" : "warn",
                value: !url ? "No relay address yet" : relayContact.ok ? `Connected (${String(relayContact.at).replace("T", " ").slice(0, 16)})`
                    : relayContact.at ? `Cannot reach it: ${relayContact.error ?? ""}`.slice(0, 160) : "Connecting…",
                hint: !url ? "The owner publishes it (docs/RELAY-SERVER.md); Admin → Updates → Check now fetches it"
                    : !relayContact.ok && relayContact.at ? "Phones cannot reach the hospital: check this PC's internet" : undefined });
            add({ key: "phones", group: "Phones", label: "Linked phones", level: "info", value: String(phones) });
        }
        const toComplete = d.get(`SELECT COUNT(*) n FROM items i WHERE i.active = 1 AND (
        COALESCE(TRIM(i.form), '') = '' OR COALESCE(TRIM(i.unit), '') = '' OR COALESCE(TRIM(i.class), '') = ''
        OR (COALESCE(TRIM(i.active_ingredient), '') = '' AND COALESCE(i.form, '') NOT IN ('مستلزمات', 'خيوط')))`)?.n ?? 0;
        add({ key: "items_to_complete", group: "Data", label: "Items missing details", level: toComplete ? "warn" : "ok",
            value: toComplete ? `${toComplete} ${toComplete === 1 ? "item" : "items"}` : "None", hint: toComplete ? "Items → Complete details" : undefined });
        const noKit = d.get(`SELECT COUNT(*) n FROM operations o WHERE o.active = 1 AND NOT EXISTS (
        SELECT 1 FROM operation_kits k JOIN operation_kit_lines l ON l.kit_id = k.id WHERE k.operation_id = o.id AND k.active = 1)`)?.n ?? 0;
        add({ key: "operations_without_kit", group: "Data", label: "Operations without a kit", level: noKit ? "warn" : "ok",
            value: noKit ? `${noKit} ${noKit === 1 ? "operation" : "operations"}` : "None", hint: noKit ? "Operations → The hospital's standard kits, or build the kit on the operation" : undefined });
    }
    // ---- labels (1.52): without the licensed font the labels print in another, and do not match the old ones
    const font = labelFontStatus();
    add({ key: "label_font", group: "Labels", label: "Label font (Hacen Eltaroute Text)", level: font.present ? "ok" : "danger",
        value: font.present ? (font.source === "uploaded" ? "Uploaded" : "Installed on this PC") : "Missing",
        hint: font.present ? undefined : role === "pharmacy" ? "It comes from the main server once an admin uploads it there (Admin → Labels)" : "Upload it in Admin → Labels: every pharmacy PC then takes it from here" });
    // ---- updates and licence
    const u = updateStatus();
    add({ key: "update", group: "Updates and licence", label: "Updates", level: u.killed ? "danger" : u.updateAvailable ? "warn" : u.lastResult === "failed" ? "warn" : "ok",
        value: u.killed ? `Turned off: ${u.lockMessage ?? ""}` : u.updateAvailable ? `${u.latestVersion} is available` : u.lastCheckAt ? `Up to date (checked ${String(u.lastCheckAt).replace("T", " ").slice(0, 16)})` : "Not checked yet",
        hint: u.updateAvailable ? "Install it from Admin → Updates" : u.lastResult === "failed" ? `Could not reach the releases site: ${u.lastError ?? ""}` : undefined });
    const l = licenceStatus();
    if (l.required)
        add({ key: "licence", group: "Updates and licence", label: "Licence", level: l.state === "licensed" ? "ok" : l.state === "grace" ? "warn" : "danger",
            value: l.state === "licensed" ? `Licensed${l.hospital ? ` to ${l.hospital}` : ""}` : l.state === "grace" ? `Not licensed yet — works until ${String(l.graceUntil).slice(0, 10)}` : "Not licensed", hint: l.message ?? undefined });
    // ---- security
    const tls = tlsInfo();
    if (role === "server")
        add({ key: "https", group: "Security", label: "Encrypted network (HTTPS)", level: tls ? "ok" : "warn",
            value: tls ? `On — certificate ${tls.fingerprint.slice(0, 23)}…, valid until ${tls.validTo.slice(0, 10)}` : "Off", hint: tls ? undefined : "HTTPS is on unless the server was started with HPS_NO_TLS=1: remove that and restart the server" });
    if (role === "pharmacy")
        add({ key: "https", group: "Security", label: "Encrypted link to the main server", level: nodeConfig().serverCert ? "ok" : "warn",
            value: nodeConfig().serverCert ? "On (the main server's certificate is pinned)" : "Plain HTTP", hint: nodeConfig().serverCert ? undefined : "This PC switches at its next sync with the main server (one from release 1.8 on)" });
    const admins = d.all("SELECT id, role, role_id, totp_enabled FROM users WHERE active = 1").filter((x) => {
        const a = accessOf(x);
        return a.owner || [...a.perms].some((p) => p.startsWith("admin."));
    });
    const without = admins.filter((a) => !a.totp_enabled).length;
    add({ key: "totp", group: "Security", label: "Two-step sign-in for administrators", level: without === 0 ? "ok" : settingBool("auth.totp_admins") ? "warn" : "info",
        value: admins.length ? `${admins.length - without} of ${admins.length} use it` : "No administrators",
        hint: without ? "Each administrator turns it on from their own menu → Two-step sign-in" : undefined });
    const idle = Number(d.get("SELECT value FROM settings WHERE key = 'auth.idle_lock_minutes'")?.value ?? 15);
    add({ key: "idle", group: "Security", label: "Screen lock when idle", level: idle > 0 ? "ok" : "warn", value: idle > 0 ? `After ${idle} minutes` : "Off", hint: idle > 0 ? undefined : "Settings → Security → Lock the screen after" });
    const rank = { danger: 3, warn: 2, ok: 1, info: 0 };
    const overall = items.reduce((w, i) => (rank[i.level] > rank[w] ? i.level : w), "ok");
    return { at: nowIso(), overall, items };
}
/** A full check of the database pages (minutes on a large database): kept for the health page. */
export function checkDatabase() {
    const result = String(db().raw.pragma("quick_check", { simple: true }) ?? "");
    const at = nowIso();
    db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('health.integrity', ?)", [JSON.stringify({ at, result })]);
    return { result, at };
}
