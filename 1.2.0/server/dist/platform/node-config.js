// This PC's place in the hospital network, kept in <data>/node.json.
//   server   - the main server: holds the hospital database, every pharmacy PC syncs with it
//   pharmacy - a pharmacy PC: works through the main server and keeps a local encrypted copy so it can carry on
//              alone (its own pharmacy's work) when the network is down
//   unset    - a fresh install that has not been set up yet (the setup screen asks)
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dataPath } from "./paths.js";
const file = () => dataPath("node.json");
let cached = null;
export function nodeConfig() {
    if (cached)
        return cached;
    if (existsSync(file()))
        cached = JSON.parse(readFileSync(file(), "utf8"));
    else {
        // A brand-new install is "unset" (the setup screen asks). An explicit NODE_ROLE wins. A pre-networking database
        // (users but no node.json) is upgraded to "server" by main.ts, which can see the users table.
        const role = process.env.NODE_ROLE === "server" || process.env.NODE_ROLE === "pharmacy" ? process.env.NODE_ROLE : "unset";
        cached = { role, nodeUuid: randomUUID(), name: hostname() };
        if (role !== "unset")
            saveNodeConfig(cached);
    }
    return cached;
}
export function saveNodeConfig(c) {
    cached = c;
    mkdirSync(dataPath(), { recursive: true });
    const tmp = file() + ".tmp";
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, file());
}
export function updateNodeConfig(patch) { saveNodeConfig({ ...nodeConfig(), ...patch }); }
/** For tests. */
export function resetNodeConfigCache() { cached = null; }
