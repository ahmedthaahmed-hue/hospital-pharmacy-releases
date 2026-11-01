import { hostname } from "node:os";
import { isIP } from "node:net";
import { settingStr } from "../core/settings.js";
const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".intranet", ".localdomain", ".home.arpa", ".localhost"];
/** The name part of a Host header ("PC-1:8080", "[fe80::1]:8080", "10.0.0.5"), lower case; null when there is none. */
export function hostName(header) {
    if (!header)
        return null;
    let h = header.trim().toLowerCase();
    if (h.startsWith("[")) {
        const end = h.indexOf("]");
        return end > 1 ? h.slice(1, end) : null;
    }
    const colon = h.lastIndexOf(":");
    if (colon !== -1 && h.indexOf(":") === colon)
        h = h.slice(0, colon); // (one colon: a port; more: a bare IPv6 address)
    h = h.replace(/\.$/, "");
    return h || null;
}
/** The extra names an admin listed: split on commas, spaces or new lines. */
export function nameList(v) {
    return (v ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
}
/** Whether a name is one this server answers to. `extra`: the admin's names (and HPS_ALLOWED_HOSTS); `self`: this PC's. */
export function hostAllowed(name, extra = [], self = []) {
    if (!name)
        return false;
    if (extra.includes("*"))
        return true;
    if (isIP(name) || name === "localhost")
        return true;
    if (!name.includes("."))
        return /^[a-z0-9]([a-z0-9-_]{0,62})$/.test(name);
    if (LOCAL_SUFFIXES.some((s) => name.endsWith(s)))
        return true;
    if (self.includes(name))
        return true;
    return extra.some((e) => (e.startsWith("*.") ? name.endsWith(e.slice(1)) || name === e.slice(2) : name === e));
}
function selfNames() {
    const h = hostname().toLowerCase();
    return [h, h.split(".")[0]];
}
/** The setting is read at most every 10 s (every request would otherwise read it). */
let cache = null;
function extraNames() {
    if (cache && Date.now() - cache.at < 10_000)
        return cache.names;
    let fromSetting = [];
    try {
        fromSetting = nameList(settingStr("net.allowed_hosts"));
    }
    catch { /* no database yet (first run) */ }
    const names = [...fromSetting, ...nameList(process.env.HPS_ALLOWED_HOSTS)];
    cache = { at: Date.now(), names };
    return names;
}
/** (after the setting changes, and for tests) */
export function forgetAllowedHosts() { cache = null; }
export function hostGate(app) {
    app.addHook("onRequest", async (req, reply) => {
        const url = req.url.split(/[?#]/)[0];
        if (url.startsWith("/api/sync/"))
            return; // pharmacy PCs: their own key, whatever name they use
        if (url === "/api/fleet/report" && req.method === "POST")
            return; // the hospitals' reports to the owner (platform/fleet.ts)
        const name = hostName(req.headers.host);
        if (hostAllowed(name, extraNames(), selfNames()))
            return;
        const shown = String(name ?? "").replace(/[^a-z0-9.:\-_[\]]/gi, "").slice(0, 80);
        const msg = `This server does not answer to the name "${shown}". Open it by its address (for example http://192.168.1.10:8080) or its PC name; an admin can add other names in Admin → Settings → Security & sessions → Other names for this server.`;
        if (url.startsWith("/api/"))
            return reply.code(421).send({ error: msg, code: "unknown_host" });
        return reply.code(421).header("content-type", "text/html; charset=utf-8")
            .send(`<!doctype html><meta charset="utf-8"><title>Unknown name</title><body style="font:15px system-ui;margin:3rem;max-width:40rem">${msg.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</body>`);
    });
}
