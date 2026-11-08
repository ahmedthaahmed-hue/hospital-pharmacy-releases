// The phone relay on its own (release 1.48, docs/RELAY-SERVER.md): what runs on the owner's small free server (an
// Oracle Cloud "Always Free" machine, or any Linux machine with Node). Only the relay's routes (platform/relay.ts):
// no database, no hospital data, no sign-in. Its key and switch live in one file (HPS_RELAY_DIR/relay.json, readable
// by the relay's own account only). It listens on 127.0.0.1 only; Caddy in front of it gives it its https address.
//
// Built into one file (tools/release/build-relay.mjs → relay.mjs, signed with the release key like every update) and
// kept up to date on the server by deploy/relay/update-relay.sh, which installs only a correctly signed file.
import Fastify from "fastify";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicRelayRoutes } from "./platform/relay-routes.js";
import { relayStatus, setRelayStore } from "./platform/relay.js";
const VERSION = typeof __RELAY_VERSION__ === "string" ? __RELAY_VERSION__ : "dev";
export function fileStore(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "relay.json");
    let data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // a relay-only server is there to relay: always on
    data.relay_receive = "1";
    const save = () => {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        renameSync(tmp, file);
        try {
            chmodSync(file, 0o600);
        }
        catch { /* not a POSIX file system */ }
    };
    return { get: (k) => data[k], set: (k, v) => { data = { ...data, [k]: v }; save(); } };
}
export async function buildRelay(dir) {
    setRelayStore(fileStore(dir));
    // behind Caddy on the same machine: the phone's address comes in X-Forwarded-For (the throttle counts per address)
    const app = Fastify({ logger: false, trustProxy: "127.0.0.1", bodyLimit: 640 * 1024 });
    app.get("/", async (_req, reply) => reply.type("text/plain").send(`Hospital Pharmacy phone relay ${VERSION}\n`));
    app.get("/health", async () => ({ ok: true, version: VERSION, hospitals: relayStatus().hospitals }));
    await app.register(publicRelayRoutes, { prefix: "/api/relay" });
    return app;
}
const isMain = process.argv[1] && /relay(-main)?\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
    const dir = process.env.HPS_RELAY_DIR ?? "/var/lib/hps-relay";
    const port = Number(process.env.HPS_RELAY_PORT ?? 8787);
    const app = await buildRelay(dir);
    await app.listen({ port, host: process.env.HPS_RELAY_HOST ?? "127.0.0.1" });
    console.log(`Hospital Pharmacy phone relay ${VERSION} on ${port}`);
    for (const s of ["SIGTERM", "SIGINT"])
        process.on(s, () => { void app.close().then(() => process.exit(0)); });
}
