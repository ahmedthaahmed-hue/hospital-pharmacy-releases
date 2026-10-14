import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, parse } from "../lib/http.js";
import { loadSession, COOKIE } from "../auth/routes.js";
import { nodeConfig } from "./node-config.js";
import { fetchLicence, installLicence, licenceStatus, pharmacyPcLimit } from "./licence.js";
function status() {
    const s = licenceStatus();
    const pcsUsed = nodeConfig().role === "server" ? db().get("SELECT COUNT(*) c FROM nodes WHERE status = 'active'")?.c ?? 0 : null;
    return { ...s, role: nodeConfig().role, pcsUsed, pcsAllowed: pharmacyPcLimit() };
}
export async function licenceRoutes(app) {
    app.get("/status", async () => status());
    app.post("/install", { bodyLimit: 64 * 1024 }, async (req) => {
        const { file } = parse(z.object({ file: z.string().min(1).max(60_000) }), req.body);
        if (licenceStatus().state !== "unlicensed") {
            const ctx = loadSession(req.cookies[COOKIE]);
            if (!ctx)
                throw new HttpError(401, "Please sign in");
            if (ctx.role !== "admin" || ctx.mustChangePassword)
                throw new HttpError(403, "Only an admin can do this");
        }
        try {
            installLicence(file);
        }
        catch (e) {
            throw new HttpError(400, String(e?.message ?? e));
        }
        return status();
    });
    app.post("/check", async () => {
        if (nodeConfig().role !== "server")
            throw new HttpError(409, "Only the main server holds a licence");
        try {
            await fetchLicence();
        }
        catch (e) {
            throw new HttpError(502, String(e?.message ?? e));
        }
        return status();
    });
}
