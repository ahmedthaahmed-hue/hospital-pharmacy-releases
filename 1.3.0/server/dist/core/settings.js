// Settings registry — the single list of hospital-wide settings: key, group, label/hint, kind, default and
// limits. The admin API validates against it, /api/lookups and /api/admin/settings return values merged over the
// defaults (so a new key works without a migration), and the admin "Settings Center" renders its form from the metadata
// served at /api/admin/settings/schema. Readers use the typed getters below, which fall back to the default whenever a
// stored value is missing or invalid.
import { z } from "zod";
import { db } from "../db/index.js";
export const GROUPS = [
    { key: "hospital", label: "Identity & reports", hint: "Hospital name, messages to users and report header", icon: "hospital" },
    { key: "appearance", label: "Default appearance", hint: "How the system looks for every user unless they customise their own device", icon: "palette" },
    { key: "screens", label: "Screens & navigation", hint: "Screen names, which screens are shown, and the phone tab bar", icon: "layout" },
    { key: "stock", label: "Stock", hint: "Low stock threshold and expiry warnings", icon: "boxes" },
    { key: "alerts", label: "Alerts", hint: "What the alerts bell shows and how often it refreshes", icon: "bell" },
    { key: "analytics", label: "Analytics", hint: "Thresholds and ratios used by the analytics dashboard, and the order of its sections", icon: "activity" },
    { key: "printing", label: "Printing & labels", hint: "Label size and what is printed on it", icon: "printer" },
    { key: "security", label: "Security & sessions", hint: "Session length and password rules", icon: "lock" },
    { key: "backup", label: "Backups", hint: "Where backups go, how often, and how long they are kept", icon: "database" },
    { key: "schedule", label: "Medical day", hint: "Schedule engine rules — read only", icon: "calendar" },
];
/** Screens (nav paths) that settings may refer to. Keep in sync with web/src/app/nav.tsx. */
export const SCREENS = ["/", "/runs", "/walkin", "/patients", "/analytics", "/stock", "/items", "/templates", "/operations", "/reports", "/chat", "/tutorial", "/admin"];
const HIDEABLE = SCREENS.filter((s) => s !== "/admin");
/** Analytics dashboard sections, in their default order. Keep in sync with web/src/pages/analytics. */
export const ANALYTICS_SECTIONS = [
    { id: "kpis", label: "Key indicators" },
    { id: "trend", label: "Daily dispensing and forecast" },
    { id: "insights", label: "Insights" },
    { id: "heatmap", label: "Peak hours heatmap" },
    { id: "departments", label: "Departments" },
    { id: "staff", label: "User activity" },
    { id: "topItems", label: "Top items by use" },
    { id: "abc", label: "ABC analysis" },
    { id: "returns", label: "Returns analysis" },
    { id: "stock", label: "Stock health (radar, cover and expiry)" },
    { id: "reorder", label: "Reorder suggestions" },
    { id: "deadStock", label: "Dead stock" },
    { id: "cover", label: "Days of cover" },
    { id: "locations", label: "Pharmacy comparison" },
];
const jsonOk = (v, f) => { try {
    return f(JSON.parse(v));
}
catch {
    return false;
} };
const pathArray = (allowed) => (o) => Array.isArray(o) && o.every((p) => typeof p === "string" && allowed.includes(p)) && new Set(o).size === o.length;
const bool = (key, group, label, def, hint) => ({ key, group, label, hint, kind: "bool", default: def ? "1" : "0" });
const int = (key, group, label, def, min, max, unit, hint) => ({ key, group, label, hint, kind: "int", default: String(def), min, max, unit });
const DAYS_UNIT = "days";
export const SETTINGS = [
    // ---- hospital
    { key: "hospital.name", group: "hospital", label: "Hospital name", hint: "Shown at the top of the side menu, on the sign-in screen and on printed reports.", kind: "text", default: "مستشفى", max: 80 },
    { key: "hospital.subtitle", group: "hospital", label: "Second line under the name", hint: "For example the pharmacy or department name.", kind: "text", default: "الصيدلية الداخلية", max: 60, optional: true },
    { key: "report.header", group: "hospital", label: "Report header", hint: "Extra line at the top of every printed report (address or licence number, for example).", kind: "text", default: "", max: 120, optional: true },
    { key: "report.footer", group: "hospital", label: "Report footer", hint: "Printed at the bottom of every report (signature, note, phone…).", kind: "text", default: "", max: 160, optional: true },
    { key: "ui.announcement", group: "hospital", label: "Announcement for all users", hint: "A bar shown at the top of every screen — leave empty to hide it.", kind: "longtext", default: "", max: 300, optional: true },
    { key: "ui.announcement_tone", group: "hospital", label: "Announcement colour", kind: "enum", default: "info",
        options: [{ value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "danger", label: "Urgent" }, { value: "ok", label: "Good news" }] },
    { key: "auth.login_message", group: "hospital", label: "Sign-in screen message", hint: "Shown under the sign-in form (a support phone number, for example).", kind: "text", default: "", max: 200, optional: true },
    // ---- appearance (each user may still override on their own device unless locked)
    { key: "ui.theme", group: "appearance", label: "Mode", kind: "enum", default: "light",
        options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Follow device" }] },
    { key: "ui.accent", group: "appearance", label: "Accent colour", kind: "enum", default: "sapphire",
        options: [{ value: "sapphire", label: "Electric blue" }, { value: "emerald", label: "Emerald" }, { value: "amethyst", label: "Amethyst" }, { value: "copper", label: "Coral" }] },
    { key: "ui.font", group: "appearance", label: "Font", kind: "enum", default: "tajawal",
        options: [{ value: "tajawal", label: "Tajawal + Alexandria" }, { value: "readex", label: "Readex Pro" }, { value: "plex", label: "IBM Plex Sans Arabic" }] },
    { key: "ui.density", group: "appearance", label: "Density", kind: "enum", default: "comfortable",
        options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
    { key: "ui.motion", group: "appearance", label: "Motion", kind: "enum", default: "full",
        options: [{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }] },
    { key: "ui.backdrop", group: "appearance", label: "Dotted background", kind: "enum", default: "on",
        options: [{ value: "on", label: "On" }, { value: "off", label: "Plain" }] },
    bool("ui.show_legacy_names", "appearance", "Show Access form names under screen names", false),
    bool("ui.lock_appearance", "appearance", "Stop users changing the appearance", false, "When on, everyone sees the appearance chosen here and the appearance options are hidden from them."),
    // ---- screens
    { key: "ui.nav_labels", group: "screens", label: "Screen names", hint: "The original names from the Access system are the defaults.", kind: "json", default: "{}", editor: "nav_labels",
        check: (v) => jsonOk(v, (o) => !!o && typeof o === "object" && !Array.isArray(o)
            && Object.entries(o).every(([k, x]) => /^\/[a-z-]*$/.test(k) && typeof x === "string" && x.trim().length > 0 && x.length <= 40)) },
    { key: "ui.hidden_screens", group: "screens", label: "Hidden screens", hint: "Hidden from the menu and search for non-admins, and cannot be opened.", kind: "json", default: "[]", editor: "screens",
        check: (v) => jsonOk(v, pathArray(HIDEABLE)) },
    { key: "ui.mobile_tabs", group: "screens", label: "Phone tab bar", hint: "Up to four screens shown in the bottom bar on phones.", kind: "json", default: JSON.stringify(["/", "/runs", "/walkin", "/stock"]), editor: "mobile_tabs",
        check: (v) => jsonOk(v, (o) => pathArray(SCREENS)(o) && o.length >= 2 && o.length <= 4) },
    { key: "ui.home_screen", group: "screens", label: "First screen after sign-in", kind: "enum", default: "/",
        options: HIDEABLE.map((p) => ({ value: p, label: p })) },
    bool("ui.lock_layouts", "screens", "Stop users changing their own layouts", false, "When on, everyone sees the layouts saved for the hospital, their pharmacy and their PC; personal layouts are ignored and \"Only me\" is not offered."),
    // ---- stock
    int("stock.low_threshold", "stock", "Low stock threshold", 10, 1, 100000, "units", "An item whose usable stock is below this shows as “Low” on the Stock screen."),
    int("stock.expiry_warn_days", "stock", "Expiry warning window", 90, 7, 730, DAYS_UNIT, "Batches that expire within this window show under “Expiring soon”."),
    // ---- alerts
    bool("alerts.expired", "alerts", "Expired batches", true),
    bool("alerts.out_of_stock", "alerts", "Out-of-stock items", true),
    bool("alerts.critical", "alerts", "Items with critical cover", true),
    bool("alerts.expiring", "alerts", "Batches expiring soon", true),
    bool("alerts.temp", "alerts", "Temporary (TEMP) stock", true),
    int("alerts.expiring_days", "alerts", "“Expiring soon” in the bell within", 30, 7, 180, DAYS_UNIT),
    int("alerts.refresh_minutes", "alerts", "Refresh alerts every", 3, 1, 60, "minutes"),
    bool("alerts.animate", "alerts", "Shake the bell on an urgent alert", true),
    // ---- analytics
    { key: "analytics.default_days", group: "analytics", label: "Default period", kind: "enum", default: "30",
        options: [{ value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }, { value: "30", label: "1 month" }, { value: "90", label: "3 months" }, { value: "180", label: "6 months" }, { value: "365", label: "1 year" }] },
    int("analytics.cover_critical_days", "analytics", "Critical cover below", 7, 1, 60, DAYS_UNIT, "Days of cover = on hand ÷ average daily use."),
    int("analytics.cover_low_days", "analytics", "Low cover up to", 14, 2, 120, DAYS_UNIT, "Must be greater than the critical cover threshold."),
    int("analytics.target_cover_days", "analytics", "Target cover for reorder suggestions", 30, 7, 180, DAYS_UNIT, "The suggested quantity lasts this many days."),
    int("analytics.abc_a", "analytics", "Class A threshold", 80, 50, 95, "%", "Items that make up this first share of total use."),
    int("analytics.abc_b", "analytics", "Class B threshold", 95, 60, 99, "%", "Must be greater than the class A threshold; the rest is class C."),
    int("analytics.risk_window_days", "analytics", "Expected waste window", 120, 30, 365, DAYS_UNIT, "Batches that expire within this window are checked for waste."),
    int("analytics.radar_days", "analytics", "Expiry radar range", 365, 90, 730, DAYS_UNIT),
    int("analytics.dead_stock_days", "analytics", "Dead stock: not dispensed for", 90, 30, 365, DAYS_UNIT),
    int("analytics.top_n", "analytics", "Items in lists", 10, 5, 30, "items"),
    { key: "analytics.anomaly_sigma", group: "analytics", label: "Unusual day sensitivity", hint: "Standard deviations from the mean; lower = more alerts.", kind: "number", default: "2", min: 1, max: 4 },
    int("analytics.forecast_days", "analytics", "Forecast days", 14, 0, 60, DAYS_UNIT, "Zero hides the forecast."),
    { key: "analytics.staff_ranking", group: "analytics", label: "Who sees user activity", kind: "enum", default: "all",
        options: [{ value: "all", label: "Everyone" }, { value: "admins", label: "Admins only" }, { value: "off", label: "No one" }] },
    { key: "analytics.sections", group: "analytics", label: "Dashboard sections and order", kind: "json", default: "[]", editor: "sections",
        hint: "Reorder the sections and hide what you do not need. An empty list = the default order.",
        check: (v) => jsonOk(v, (o) => Array.isArray(o) && o.every((x) => x && typeof x === "object"
            && ANALYTICS_SECTIONS.some((s) => s.id === x.id) && typeof x.on === "boolean")
            && new Set(o.map((x) => x.id)).size === o.length) },
    // ---- printing
    { key: "label.width_mm", group: "printing", label: "Label width", kind: "number", default: "55", min: 20, max: 150, unit: "mm" },
    { key: "label.height_mm", group: "printing", label: "Label height", kind: "number", default: "55", min: 15, max: 150, unit: "mm" },
    bool("label.preview", "printing", "Live label preview", true, "Shows labels as they will print on every print screen; each user can turn it on or off for themselves on each screen."),
    { key: "label.preview_view", group: "printing", label: "Default preview view", kind: "enum", default: "single",
        options: [{ value: "single", label: "One label at a time" }, { value: "grid", label: "All labels" }] },
    // ---- security
    int("auth.session_hours", "security", "Session length", 14, 1, 72, "hours", "Users must sign in again after this. Applies to new sessions."),
    int("auth.password_min", "security", "Minimum password length", 6, 6, 64, "characters"),
    // ---- backup
    { key: "backup.dir", group: "backup", label: "Backup folder", hint: "A path on the server PC; a relative path starts from the server's working folder. A different disk from the data disk is best.", kind: "text", default: "backups", max: 260 },
    int("backup.keep_days", "backup", "Keep backups for", 30, 1, 3650, DAYS_UNIT, "Older backups are deleted automatically."),
    int("backup.interval_hours", "backup", "Automatic backup every", 1, 1, 24, "hours"),
    // ---- schedule (engine rules: read-only)
    { key: "schedule.day_start", group: "schedule", label: "Medical day starts", kind: "time", default: "06:00", readonly: true },
    { key: "schedule.grace_hours", group: "schedule", label: "Late dose grace period", kind: "int", default: "3", unit: "hours", readonly: true },
];
export const DEFS = new Map(SETTINGS.map((d) => [d.key, d]));
/** A blank number field is invalid (z.coerce would turn "" into 0). */
const blank = (v) => (typeof v === "string" && v.trim() === "" ? Number.NaN : v);
function zodOf(d) {
    const lim = (n) => {
        if (d.min != null)
            n = n.min(d.min, `${d.label}: at least ${d.min}`);
        if (d.max != null)
            n = n.max(d.max, `${d.label}: at most ${d.max}`);
        return n;
    };
    switch (d.kind) {
        case "text":
        case "longtext": {
            const s = z.string().trim().max(d.max ?? 200, `${d.label} is too long`);
            return (d.optional ? s : s.min(1, `Enter the ${d.label.toLowerCase()}`));
        }
        case "int": return z.preprocess(blank, z.coerce.number({ message: `${d.label}: not a valid number` }).pipe(lim(z.number().int(`${d.label}: must be a whole number`)))).transform(String);
        case "number": return z.preprocess(blank, z.coerce.number({ message: `${d.label}: not a valid number` }).pipe(lim(z.number()))).transform(String);
        case "bool": return z.union([z.boolean(), z.literal(0), z.literal(1), z.enum(["0", "1", "true", "false"])])
            .transform((v) => (v === true || v === 1 || v === "1" || v === "true" ? "1" : "0"));
        case "enum": return z.enum(d.options.map((o) => o.value), { message: `${d.label}: value not allowed` });
        case "json": return z.string().max(8000).refine((v) => d.check?.(v) ?? jsonOk(v, () => true), `${d.label}: invalid value`);
        case "time": return z.string().regex(/^\d{2}:\d{2}$/);
    }
}
/** Body schema of PUT /admin/settings: every editable key, optional; unknown or read-only keys are rejected. */
export const SETTINGS_BODY = z.object(Object.fromEntries(SETTINGS.filter((d) => !d.readonly).map((d) => [d.key, zodOf(d).optional()]))).strict()
    .transform((b) => b);
/** Cross-field rules, checked on the merged (stored + incoming) values. Returns the first problem or null. */
export function crossCheck(v) {
    if (Number(v["analytics.cover_low_days"]) <= Number(v["analytics.cover_critical_days"]))
        return "Low cover threshold must be greater than the critical cover threshold";
    if (Number(v["analytics.abc_b"]) <= Number(v["analytics.abc_a"]))
        return "Class B threshold must be greater than the class A threshold";
    const hidden = JSON.parse(v["ui.hidden_screens"] || "[]");
    if (hidden.includes(v["ui.home_screen"]))
        return "The first screen cannot be hidden";
    if (hidden.length >= SCREENS.length - 1)
        return "Leave at least one screen visible";
    return null;
}
/** Every setting: stored value when valid, else the default. Unknown stored keys are passed through untouched. */
export function allSettings() {
    const out = {};
    for (const r of db().all("SELECT key, value FROM settings"))
        if (r.value != null)
            out[r.key] = r.value;
    for (const d of SETTINGS)
        out[d.key] = normalised(d, out[d.key]);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
/** Stored value in its normal form (e.g. a hand-edited bool "true" → "1"), or the default when missing/invalid. */
function normalised(d, v) {
    if (v == null)
        return d.default;
    if (d.readonly)
        return v !== "" ? v : d.default;
    const r = zodOf(d).safeParse(v);
    return r.success ? r.data : d.default;
}
function raw(key) {
    const d = DEFS.get(key);
    const v = db().get("SELECT value FROM settings WHERE key=?", [key])?.value;
    return d ? normalised(d, v) : v ?? "";
}
export const settingStr = (key) => raw(key);
export const settingNum = (key) => Number(raw(key));
export const settingBool = (key) => raw(key) === "1";
export function settingJson(key) { return JSON.parse(raw(key)); }
/** Metadata for the admin form (no functions). */
export function settingsSchema() {
    return {
        groups: GROUPS,
        settings: SETTINGS.map(({ check: _c, ...d }) => d),
        screens: SCREENS,
        analyticsSections: ANALYTICS_SECTIONS,
    };
}
