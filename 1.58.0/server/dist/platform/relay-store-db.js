// The relay's switch and key in the encrypted database (schema_meta), for a PC running the whole app (platform/relay.ts).
import { db } from "../db/index.js";
export const dbRelayStore = {
    get: (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value,
    set: (k, v) => { db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]); },
};
