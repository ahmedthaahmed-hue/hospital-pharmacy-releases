import { assertNotThrottled, noteFailure } from "../lib/rate-limit.js";
import { pollFor, relayKey, relayOn, replyFrom, toHospital } from "./relay.js";
/** The phone app is its own origin (capacitor://localhost, https://localhost): it may call the relay, without cookies. */
const cors = (reply) => reply.header("access-control-allow-origin", "*").header("access-control-allow-methods", "POST, GET, OPTIONS")
    .header("access-control-allow-headers", "content-type").header("access-control-max-age", "600");
export async function publicRelayRoutes(app) {
    // envelopes are text (main servers sign the exact bytes); JSON only, and small
    app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 600 * 1024 }, (_req, body, done) => done(null, body));
    const json = async (req, reply) => { if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? "")))
        return reply.status(415).send({ error: "JSON only" }); };
    app.options("/to/:server", async (_req, reply) => cors(reply).status(204).send());
    app.get("/key", async (_req, reply) => {
        if (!relayOn())
            return reply.status(404).send({ error: "Not found" });
        return cors(reply).send({ pub: (await relayKey()).pub });
    });
    app.post("/to/:server", { bodyLimit: 600 * 1024, onRequest: json }, async (req, reply) => {
        cors(reply);
        try {
            assertNotThrottled("relay", req.ip, "");
        }
        catch {
            return reply.status(429).send({ error: "Too many requests from this address — try again later" });
        }
        const server = String(req.params.server ?? "").slice(0, 64);
        const a = await toHospital(server, String(req.body ?? ""));
        if (a.status === 404 || a.status === 503)
            noteFailure("relay", req.ip, ""); // guessing at hospitals
        return reply.status(a.status).header("content-type", "application/json").send(a.body);
    });
    app.post("/poll", { bodyLimit: 4 * 1024, onRequest: json }, async (req, reply) => {
        try {
            assertNotThrottled("relay-server", req.ip, "");
        }
        catch {
            return reply.status(429).send({ error: "Too many refused calls" });
        }
        const r = await pollFor(req.headers, String(req.body ?? ""));
        if (r.status === 401)
            noteFailure("relay-server", req.ip, "");
        return reply.status(r.status).send(r.status === 200 ? { items: r.items } : { error: r.status === 401 ? "Refused" : "Not found" });
    });
    app.post("/reply", { bodyLimit: 600 * 1024, onRequest: json }, async (req, reply) => {
        try {
            assertNotThrottled("relay-server", req.ip, "");
        }
        catch {
            return reply.status(429).send({ error: "Too many refused calls" });
        }
        const status = await replyFrom(req.headers, String(req.body ?? ""));
        if (status === 401)
            noteFailure("relay-server", req.ip, "");
        return reply.status(status).send(status === 200 ? { ok: true } : { error: "Refused" });
    });
}
