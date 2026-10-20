import { featureGateHook } from "./core/feature-gate.js";
import { publicFleetRoutes } from "./modules/fleet/routes.js";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HttpError } from "./lib/http.js";
import { authRoutes, loadSession, sessionGate, COOKIE } from "./auth/routes.js";
import { modules } from "./modules/index.js";
import { opDedupHooks, systemRoutes, syncRoutes, networkRoutes, internalCtx, isInternal } from "./platform/hub.js";
import { recordWrites, aliasOfflineIds, queuedWrite } from "./platform/pharmacy-agent.js";
import { outcomeOf } from "./platform/outcome.js";
import { updateRoutes, lockGate } from "./platform/update-routes.js";
import { noteActivity } from "./platform/updater.js";
import { demoResetting } from "./platform/demo-reset.js";
import { licenceRoutes } from "./platform/licence-routes.js";
import { appRoot } from "./platform/paths.js";
import { nodeConfig } from "./platform/node-config.js";
import { nowIso } from "./lib/time.js";
import { localRoutes } from "./platform/local-routes.js";
import { requestScopeHooks, currentScope } from "./platform/clock.js";
export async function buildApp(opts = {}) {
    const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024,
        // Pharmacy PC: ids made here that the main server has renumbered (platform/pharmacy-agent.ts aliasOfflineIds).
        rewriteUrl: (req) => { const url = req.url ?? "/"; try {
            return url.startsWith("/api/") ? aliasOfflineIds(url) : url;
        }
        catch {
            return url;
        } } });
    // Tests walk every registered route (security.test.ts) to check each one is guarded.
    if (opts.onRoute)
        app.addHook("onRoute", opts.onRoute);
    await app.register(cookie);
    // Uploaded files (database restore) arrive as raw bytes. Only the restore route raises the size limit (its own
    // bodyLimit): a parser-wide 1 GB let anyone, signed in or not, make the server buffer 1 GB per request on every public
    // route (sign-in, setup, sync).
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    requestScopeHooks(app); // first: every later hook and handler runs in the request's own scope
    sameOriginWrites(app);
    securityHeaders(app);
    lockGate(app);
    opDedupHooks(app);
    // Pharmacy PC: users, pharmacies, lookups, settings and backups are the main server's. A change made here would apply
    // to this PC's copy only, be refused when replayed and vanish with the next copy from the main server. (Decided by
    // the route that matched, so an encoded address cannot slip past.)
    app.addHook("onRequest", async (req) => {
        if (nodeConfig().role === "pharmacy" && /^(POST|PUT|PATCH|DELETE)$/.test(req.method) && /^\/api\/admin(\/|$)/.test(req.routeOptions?.url ?? ""))
            throw new HttpError(409, "Do this on the main server — this pharmacy PC gets users, pharmacies, lookups and settings from it", { code: "main_server_only" });
    });
    // The demo hospital being rebuilt (its nightly reset): a minute's wait, then everything works again.
    app.addHook("onRequest", async (req, reply) => {
        if (!demoResetting() || !req.url.startsWith("/api/") || req.url.startsWith("/api/local/info") || req.url.startsWith("/api/local/update-progress"))
            return;
        return reply.code(503).header("retry-after", "30").send({ error: "The demo is being reset to its starting data — try again in a minute", code: "demo_resetting" });
    });
    // Main server: work saved by someone signed in delays an automatic update (updater.ts autoUpdate). Only real work —
    // what a pharmacy PC would send on (queuedWrite) — not the screens' own background calls (the chat heartbeat every
    // 20 s, the screen lock's activity), which would otherwise keep any open screen from ever being quiet.
    app.addHook("onResponse", async (req) => {
        if (req.ctx?.userId && queuedWrite(req.url, req.method))
            noteActivity();
    });
    app.addHook("preValidation", async (req) => {
        if (nodeConfig().role !== "pharmacy" || req.body == null || typeof req.body !== "object" || Buffer.isBuffer(req.body))
            return;
        const text = JSON.stringify(req.body), mapped = aliasOfflineIds(text);
        if (mapped !== text)
            req.body = JSON.parse(mapped);
    });
    // On a pharmacy PC, remember each successful write so it can be replayed on the main server.
    // The REQUEST body is what gets replayed (payload here is the response).
    // (Its outbox row commits with its work, once the request is final — body mapped above, user known.)
    const bodyText = (req) => (req.body === undefined || Buffer.isBuffer(req.body) ? undefined : JSON.stringify(req.body));
    app.addHook("preHandler", async (req) => {
        const s = currentScope();
        if (nodeConfig().role !== "pharmacy" || !s || s.pcWrite || !queuedWrite(req.url, req.method))
            return;
        s.pcWrite = { opId: req.headers["x-op-id"] || randomUUID(), queued: false, closed: false,
            request: () => ({ method: req.method, url: req.url, body: bodyText(req), ctx: req.ctx }) };
    });
    app.addHook("onSend", async (req, reply, payload) => {
        if (nodeConfig().role === "pharmacy" && !req.opReplayed) {
            const s = currentScope(), w = s?.pcWrite;
            if (w)
                w.closed = true;
            recordWrites(req.url, req.method, reply.statusCode, bodyText(req), w?.opId ?? (req.headers["x-op-id"] || undefined), req.ctx, nowIso(), s?.created ?? [], { uuids: s?.uuids, outcome: outcomeOf(typeof payload === "string" ? payload : null), queued: w?.queued });
        }
        return payload;
    });
    app.setErrorHandler((err, _req, reply) => {
        if (err instanceof HttpError)
            return reply.status(err.status).send({ error: err.message, details: err.details });
        if (err?.validation)
            return reply.status(400).send({ error: "Invalid data", details: err.validation });
        const msg = String(err?.message ?? err);
        if (/UNIQUE constraint failed/.test(msg))
            return reply.status(409).send({ error: "This record already exists" });
        if (/FOREIGN KEY constraint failed/.test(msg))
            return reply.status(409).send({ error: "Cannot delete or save: the record is linked to other data" });
        if (/CHECK constraint failed/.test(msg))
            return reply.status(400).send({ error: "Value not allowed" });
        // Fastify's own client errors (empty / malformed JSON body, unsupported media type, body too large…)
        if (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500)
            return reply.status(err.statusCode).send({ error: "Invalid request", details: msg });
        app.log.error(err);
        return reply.status(500).send({ error: "Unexpected server error", details: msg });
    });
    await app.register(async (api) => {
        featureGateHook(api, isInternal); // a switched-off feature's routes answer 403 feature_off (core/feature-gate.ts)
        await api.register(authRoutes, { prefix: "/auth" });
        await api.register(systemRoutes, { prefix: "/system" });
        await api.register(syncRoutes, { prefix: "/sync" });
        await api.register(localRoutes, { prefix: "/local" });
        await api.register(licenceRoutes, { prefix: "/licence" });
        await api.register(publicFleetRoutes, { prefix: "/fleet" });
        await api.register(async (secured) => {
            secured.addHook("onRequest", async (req) => {
                // Work replayed from a pharmacy PC runs as the pharmacist who did it (platform/hub.ts); everything else needs a session.
                const ctx = internalCtx(req) ?? loadSession(req.cookies[COOKIE]);
                if (!ctx)
                    throw new HttpError(401, "Please sign in");
                // A temporary password (first admin, new user, admin reset) must be replaced before any other use — enforced here,
                // not only in the UI, so the initial password cannot be used against the API directly.
                sessionGate(ctx);
                req.ctx = ctx;
                const scope = currentScope();
                if (scope)
                    scope.userId = ctx.userId; // the database's hps_user(): who wrote an order (modules/clinical/schema.ts)
            });
            for (const [prefix, mod] of modules)
                await secured.register(mod, { prefix: `/${prefix}` });
            await secured.register(networkRoutes, { prefix: "/network" });
            await secured.register(updateRoutes, { prefix: "/update" });
        });
    }, { prefix: "/api" });
    // The install root, not the working folder: the launcher may start the server from anywhere (a startup task runs in
    // C:\Windows\System32), and then a path relative to it would serve no app at all.
    const web = opts.webDist ?? resolve(appRoot(), "web/dist");
    if (existsSync(web)) {
        await app.register(fstatic, { root: web, wildcard: false });
        app.setNotFoundHandler((req, reply) => {
            if (req.url.startsWith("/api/"))
                return reply.status(404).send({ error: "Not found" });
            // Missing files are a real 404 — a browser holding an old index.html after an upgrade asks for old hashed chunks
            // and must not get HTML back as JavaScript. Only extension-less app routes (/admin/settings…) get the SPA shell.
            const path = req.url.split(/[?#]/)[0];
            if (path.startsWith("/assets/") || /\.[^/]+$/.test(path))
                return reply.status(404).send({ error: "Not found" });
            return reply.sendFile("index.html");
        });
    }
    return app;
}
/**
 * Writes from a browser must come from this app's own pages. The session cookie is SameSite=strict, but "same site" is
 * the host, not the origin: any other web page served from the same PC (another port) or the same domain would still
 * send it, and a plain HTML form can post text/plain. Browsers name the page that sent a request (Origin,
 * Sec-Fetch-Site); requests without them (pharmacy PCs, the server's own replays, scripts) are not browser pages.
 */
function sameOriginWrites(app) {
    app.addHook("onRequest", async (req) => {
        if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !req.url.startsWith("/api/"))
            return;
        const site = req.headers["sec-fetch-site"];
        if (site === "cross-site" || site === "same-site")
            throw new HttpError(403, "Requests from another web page are not allowed");
        const origin = req.headers.origin;
        if (origin === undefined)
            return;
        let host = null;
        try {
            host = new URL(String(origin)).host;
        }
        catch { /* "null" (a sandboxed page, a file) or garbage */ }
        if (!host || host !== req.headers.host)
            throw new HttpError(403, "Requests from another web page are not allowed");
    });
}
/** Headers for every answer: no framing by other sites, no content sniffing, and no caching of patient data. */
function securityHeaders(app) {
    app.addHook("onSend", async (req, reply, payload) => {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("X-Frame-Options", "SAMEORIGIN");
        // (an answer with its own, stricter one keeps it: the hospital's logo, auth/routes.ts)
        if (!reply.hasHeader("content-security-policy"))
            reply.header("Content-Security-Policy", "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'");
        reply.header("Referrer-Policy", "same-origin");
        if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control"))
            reply.header("Cache-Control", "no-store");
        return payload;
    });
}
