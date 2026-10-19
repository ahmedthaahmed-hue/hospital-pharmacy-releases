import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, parse } from "../lib/http.js";
import { loadSession, sessionGate, COOKIE } from "../auth/routes.js";
import { nodeConfig } from "./node-config.js";
import { appVersion } from "./version.js";
import { agent } from "./pharmacy-agent.js";
import { setupServer, connectAsPharmacy } from "./setup.js";
import { autoUpdate, checkControl, checkOnOpen, lockState, pendingUpdate } from "./updater.js";
import { updateProgressReport } from "./update-progress.js";
import { licenceStatus } from "./licence.js";
import { startRoleServices } from "./services.js";
import { isDemo } from "../db/demo.js";
import { appPort, discoverServers, isEmptyDatabase, lanAddresses, loadFirstData, presetRole } from "./first-run.js";
let settingUp = false;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
export async function localRoutes(app) {
    app.get("/update-progress", async (req) => {
        const role = nodeConfig().role;
        if (req.query?.opened === "1") {
            if (role === "server")
                void checkOnOpen();
            else if (role === "pharmacy")
                agent().noteOpened();
        }
        return { ...updateProgressReport(), pending: role === "server" ? pendingUpdate() : role === "pharmacy" ? agent().pendingUpdate() : null };
    });
    app.post("/update-now", async () => {
        const lock = lockState();
        if (nodeConfig().role !== "server" || !lock.locked || lock.reason !== "too_old")
            throw new HttpError(409, "Updates install themselves; an administrator can install one now in Admin → Updates");
        await checkControl();
        if (!(await autoUpdate()))
            throw new HttpError(409, "The update could not start — it is tried again by itself in a few minutes");
        return { ok: true, restarting: true };
    });
    app.get("/info", async () => {
        const c = nodeConfig();
        const lock = lockState();
        const base = { app: "hospital-pharmacy", version: appVersion(), role: c.role, name: c.name, needsSetup: c.role === "unset",
            killed: lock.locked, lockMessage: lock.message, lockedSince: lock.since, lockReason: lock.reason, licence: licenceSummary(),
            presetRole: c.role === "unset" ? presetRole() : null, demo: isDemo(db) };
        // the addresses pharmacy PCs use to reach this main server (shown after setup and in Admin → Network)
        if (c.role !== "pharmacy")
            return { ...base, online: true, addresses: lanAddresses().map((a) => `http://${a}:${appPort()}`) };
        const s = agent().status();
        return { ...base, serverUrl: c.serverUrl, locationId: c.locationId, ...s };
    });
    app.post("/setup", async (req) => {
        if (nodeConfig().role !== "unset")
            throw new HttpError(409, "This PC is already set up");
        // Setting up takes no password (there is nothing to check it against yet) and decides who the first admin is and
        // which main server this PC trusts: only someone at this PC may do it, not whoever on the network gets there first.
        if (!LOOPBACK.test(req.ip))
            throw new HttpError(403, "Set this PC up from the PC itself: open http://localhost on it");
        const b = parse(z.object({
            role: z.enum(["server", "pharmacy"]), name: z.string().trim().min(1).max(80).optional(),
            adminUsername: z.string().trim().optional(), adminPassword: z.string().optional(),
            serverUrl: z.string().trim().url("Enter the main server address with http://, e.g. http://192.168.1.2:8080")
                .refine((u) => /^https?:\/\//i.test(u), "Enter the main server address with http://, e.g. http://192.168.1.2:8080").optional(),
            locationId: z.coerce.number().int().positive().optional(), code: z.string().trim().max(20).optional(),
        }), req.body);
        // One at a time: two connections at once (two browser tabs) would each register this PC and each take a database
        // copy, and could leave it with the key of one registration and the token of the other.
        if (settingUp)
            throw new HttpError(409, "This PC is being set up already — wait for it to finish");
        settingUp = true;
        try {
            const r = b.role === "server" ? setupServer(b) : await connectAsPharmacy(b);
            // Now that this PC has its role, start its background work (a pharmacy PC would otherwise not sync until restarted).
            startRoleServices();
            return r;
        }
        finally {
            settingUp = false;
        }
    });
    /** Main servers on this PC's local networks, for the pharmacy setup screen. Only from this PC, only before setup. */
    app.get("/discover", async (req) => {
        if (!LOOPBACK.test(req.ip))
            throw new HttpError(403, "Only from this PC");
        if (nodeConfig().role !== "unset")
            throw new HttpError(409, "This PC is already set up");
        return { servers: await discoverServers() };
    });
    /**
     * A new main server's starting data: the old system's DataBE.accdb (uploaded, with its password in x-accdb-password),
     * the demo data (?kind=demo), or one empty pharmacy (?kind=empty&pharmacy=Name). Only from this PC, only on a main
     * server whose database has nothing clinical in it yet (right after setup).
     */
    app.post("/first-data", { bodyLimit: 1024 * 1024 * 1024 }, async (req) => {
        if (!LOOPBACK.test(req.ip))
            throw new HttpError(403, "Load the first data from the main server PC itself");
        if (nodeConfig().role !== "server")
            throw new HttpError(409, "Only a main server holds the hospital's data");
        if (!isEmptyDatabase())
            throw new HttpError(409, "This server already has data");
        const kind = req.query.kind;
        if (kind === "demo")
            return loadFirstData({ kind: "demo" });
        if (kind === "empty")
            return loadFirstData({ kind: "empty", pharmacy: String(req.query.pharmacy ?? "") });
        if (kind === "accdb") {
            const file = req.body;
            if (!Buffer.isBuffer(file) || file.length < 4096)
                throw new HttpError(400, "Choose the old system's DataBE.accdb file");
            const pw = req.headers["x-accdb-password"];
            return loadFirstData({ kind: "accdb", file, password: typeof pw === "string" && pw ? decodeURIComponent(pw) : undefined });
        }
        throw new HttpError(400, "Choose where the data comes from");
    });
    app.post("/sync", async (req) => {
        signedIn(req);
        if (nodeConfig().role !== "pharmacy")
            throw new HttpError(409, "Only a pharmacy PC syncs with the main server");
        return agent().syncNow();
    });
    app.get("/failures", async (req) => {
        signedIn(req);
        if (nodeConfig().role !== "pharmacy")
            return { failures: [] };
        return { failures: db().all("SELECT op_id AS opId, at, method, url, status, error, failed_at AS failedAt FROM sync_failures ORDER BY failed_at DESC LIMIT 200") };
    });
}
/**
 * These routes sit outside the session check (the setup and locked screens use /info first), so the rest check it
 * themselves: rejected offline work names patients and pharmacists, and a sync on demand makes the main server build a
 * whole database copy, which anyone on the network could otherwise repeat without end.
 */
function signedIn(req) {
    const ctx = loadSession(req.cookies[COOKIE]);
    if (!ctx)
        throw new HttpError(401, "Please sign in");
    sessionGate(ctx);
}
/** What the shell needs: the state, the machine code (licence screen) and the end of the grace period (admin banner). */
function licenceSummary() {
    const l = licenceStatus();
    return { state: l.state, machineCode: l.machineCode, graceUntil: l.graceUntil };
}
