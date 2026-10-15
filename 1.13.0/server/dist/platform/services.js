// Background work each role runs: the main server backs up and checks the signed control file; a pharmacy PC syncs.
// Started at boot, and right after the first-run setup gives this PC its role (no restart needed).
import { startBackupSchedule } from "../modules/admin/backup.js";
import { nodeConfig } from "./node-config.js";
import { agent } from "./pharmacy-agent.js";
import { checkControl } from "./updater.js";
import { pruneAppliedOps } from "./hub.js";
import { fetchLicence, licenceStatus } from "./licence.js";
import { sendFleetReport } from "./fleet.js";
let started = false;
export function startRoleServices() {
    const role = nodeConfig().role;
    if (started || role === "unset")
        return;
    started = true;
    if (role === "server") {
        startBackupSchedule();
        // Check the signed control file (updates + the owner's off switch) now and every 30 minutes.
        // ... and, while this server has no licence, look for one published for it (licences/<machine code>.licence).
        const licence = () => { if (licenceStatus().state === "grace" || licenceStatus().state === "unlicensed")
            fetchLicence(true).catch(() => { }); };
        // ... and, when the hospital allows it, report version, licence and health to the owner (platform/fleet.ts)
        const tick = () => { void checkControl().then(() => sendFleetReport()).catch(() => { }); licence(); };
        tick();
        setInterval(tick, 30 * 60 * 1000).unref();
        // Keep the repeat-protection table small.
        const prune = () => { try {
            pruneAppliedOps();
        }
        catch { /* next day */ } };
        prune();
        setInterval(prune, 24 * 3600 * 1000).unref();
    }
    if (role === "pharmacy")
        agent().start();
}
