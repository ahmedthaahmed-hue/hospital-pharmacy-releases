import { z } from "zod";
import { audit, notFound, parse, requireOwner } from "../../lib/http.js";
import { assertNotThrottled, noteFailure } from "../../lib/rate-limit.js";
import { requireFeature } from "../../core/feature-gate.js";
import { approveHospital, fleetList, fleetReport, fleetUrl, forgetHospital, lastFleetReport, receiveReport, receivingOn, sendFleetReport, setReceiving } from "../../platform/fleet.js";
export default async function fleetRoutes(app) {
    app.get("/", async (req) => {
        requireOwner(req);
        return { receiving: receivingOn(), hospitals: fleetList(), reporting: { url: fleetUrl(), last: lastFleetReport() } };
    });
    app.put("/receive", async (req) => {
        requireOwner(req);
        const { on } = parse(z.object({ on: z.boolean() }), req.body);
        setReceiving(on);
        audit(req, "fleet.receive", "fleet", null, { on });
        return { receiving: on };
    });
    app.delete("/:machine", async (req) => {
        requireOwner(req);
        const { machine } = parse(z.object({ machine: z.string().min(4).max(80) }), req.params);
        if (!forgetHospital(machine))
            notFound("No such hospital");
        audit(req, "fleet.forget", "fleet", null, { machine });
        return { ok: true };
    });
    app.post("/:machine/approve", async (req) => {
        requireOwner(req);
        const { machine } = parse(z.object({ machine: z.string().min(4).max(80) }), req.params);
        if (!approveHospital(machine))
            notFound("No such hospital");
        audit(req, "fleet.approve", "fleet", null, { machine });
        return { ok: true };
    });
    /** What this hospital sends (to show the owner exactly what leaves), and send it now. */
    app.get("/report", async (req) => { requireOwner(req); return fleetReport(); });
    app.post("/send", async (req) => { requireOwner(req); requireFeature("fleet"); await sendFleetReport(); return { url: fleetUrl(), last: lastFleetReport() }; });
}
/** Reports from the hospitals' main servers: no session, signed with each hospital's key (platform/fleet.ts). */
export async function publicFleetRoutes(app) {
    // the signature covers the exact bytes sent, so the body is kept as text; JSON only, and small (any other type is
    // refused before its body is read)
    app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 128 * 1024 }, (_req, body, done) => done(null, body));
    app.post("/report", {
        bodyLimit: 128 * 1024,
        onRequest: async (req, reply) => { if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? "")))
            return reply.status(415).send({ error: "JSON only" }); },
    }, async (req, reply) => {
        try {
            assertNotThrottled("fleet", req.ip, "");
        }
        catch {
            return reply.status(429).send({ error: "Too many reports refused from this address — try again later" });
        }
        const status = receiveReport(String(req.body ?? ""), req.headers, req.ip);
        // refused signatures, and new registrations, count against the address: a flood of made-up hospitals stops
        if (status === 401 || status === 403 || status === 201)
            noteFailure("fleet", req.ip, "");
        return reply.status(status === 201 ? 200 : status).send(status === 200 || status === 201 ? { ok: true }
            : { error: status === 404 ? "Not found" : status === 429 ? "Not taking new hospitals now" : "Report refused" });
    });
}
