import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, audit, parse, requirePerm } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { nodeConfig } from "./node-config.js";
import { appVersion, compareVersions } from "./version.js";
import { updateStatus, checkControl, downloadAndStage, lockState, RESTART_DELAY_MS } from "./updater.js";
import { agent } from "./pharmacy-agent.js";
export const RESTART_EXIT_CODE = 69;
export async function updateRoutes(app) {
    app.addHook("preHandler", async (req) => requirePerm(req, "admin.updates"));
    app.get("/status", async () => {
        const role = nodeConfig().role;
        if (role !== "pharmacy")
            return { ...updateStatus(), role };
        // A pharmacy PC follows the main server's version (it updates from the main server, not the internet).
        const a = agent().status();
        return { ...updateStatus(), role, latestVersion: a.serverVersion, updateAvailable: a.updateAvailable, lastError: a.updateError,
            autoUpdate: process.env.HPS_LAUNCHER === "1" };
    });
    app.post("/check", async () => {
        if (nodeConfig().role !== "server")
            throw new HttpError(409, "Only the main server checks for updates online");
        return checkControl();
    });
    app.post("/apply", async (req, reply) => {
        const role = nodeConfig().role;
        if (role === "unset")
            throw new HttpError(409, "Set this PC up first");
        const { version } = parse(z.object({ version: z.string().min(1).optional() }), req.body ?? {});
        // Installing restarts the app into the new files: only the launcher (deploy/launch.ps1) can do that swap.
        if (process.env.HPS_LAUNCHER !== "1")
            throw new HttpError(409, "Start the app with its launcher (the Desktop shortcut or service) to install updates");
        if (role === "pharmacy") {
            // A pharmacy PC installs the main server's version, from the main server.
            if (agent().status().pendingOps > 0)
                throw new HttpError(409, "Work done here is still waiting to sync — try again once it is sent");
            try {
                const r = await agent().updateFromServer();
                audit(req, "system.update.apply", "system", null, { to: r.version, files: r.files, source: "main server" });
                return reply.send({ ok: true, staged: true, version: r.version, files: r.files, restarting: true });
            }
            catch (e) {
                throw new HttpError(502, String(e?.message ?? e));
            }
        }
        const target = version ?? updateStatus().latestVersion;
        if (!target)
            throw new HttpError(409, "No newer version is available");
        if (compareVersions(target, appVersion()) <= 0)
            throw new HttpError(409, `Already on ${appVersion()}`);
        let r;
        try {
            r = await downloadAndStage(target);
        }
        catch (e) {
            throw new HttpError(502, String(e?.message ?? e));
        }
        db().run("INSERT INTO audit_log(at,user_id,action,entity,details) VALUES (?,?,?,?,?)", [nowIso(), req.ctx.userId, "system.update.apply", "system", JSON.stringify({ from: appVersion(), to: target, files: r.files })]);
        // Let the response flush, then exit so the launcher swaps in the staged files and relaunches.
        reply.send({ ok: true, staged: true, version: target, files: r.files, restarting: true });
        setTimeout(() => process.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
        return reply;
    });
}
/** Lock gate: when this PC is locked (remote off switch), nothing works except the locked screen and the status. */
export function lockGate(app) {
    app.addHook("onRequest", async (req, reply) => {
        const lock = lockState();
        if (!lock.locked)
            return;
        const url = req.url.split(/[?#]/)[0];
        if (url === "/api/update/status" || url === "/api/local/info" || url === "/api/local/update-progress" || url === "/locked" || url === "/favicon.svg")
            return;
        // A locked main server still answers its PCs' heartbeat: the lock reaches them signed (release 1.32, tls.ts heartbeatMac).
        if (url === "/api/sync/heartbeat" && nodeConfig().role === "server")
            return;
        // Locked because this version is too old: it installs the new one by itself (the locked screen can start it at once).
        if (lock.reason === "too_old" && url === "/api/local/update-now")
            return;
        // No licence yet: the licence screen must be able to show this PC's code and install a licence.
        if (lock.reason === "unlicensed" && url.startsWith("/api/licence/"))
            return;
        // Locked because this version is too old: an admin can still sign in and install the update.
        if (lock.reason === "too_old" && (url.startsWith("/api/auth/") || url.startsWith("/api/update/")))
            return;
        if (url.startsWith("/api/"))
            return reply.code(423).send({ error: lock.message ?? "This system has been turned off by its owner.", code: "locked", since: lock.since, reason: lock.reason });
        if (url.startsWith("/assets/") || /\.[^/]+$/.test(url))
            return; // let the built UI assets load (the app shows the locked screen)
        // app routes: fall through to the SPA, which renders the locked screen from /api/update/status
    });
}
