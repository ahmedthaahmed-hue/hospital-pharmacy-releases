// Background work each role runs: the main server backs up and checks the signed control file; a pharmacy PC syncs.
// Started at boot, and right after the first-run setup gives this PC its role (no restart needed).
import { startBackupSchedule } from "../modules/admin/backup.js";
import { nodeConfig } from "./node-config.js";
import { agent } from "./pharmacy-agent.js";
import { autoUpdate, checkControl } from "./updater.js";
import { pruneAppliedOps } from "./hub.js";
import { fetchLicence, licenceStatus } from "./licence.js";
import { sendFleetReport } from "./fleet.js";
import { pollInbox, pollSeconds } from "../modules/his/apply.js";
import { exportDispensing } from "../modules/his/export.js";
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
        // A newer version installs itself once nobody has saved anything for a few minutes (updater.ts autoUpdate).
        setInterval(() => void autoUpdate(), 60 * 1000).unref();
        // The hospital system link (modules/his/): read the inbox folder, and write the dispensing file when due.
        const his = async () => {
            try {
                await pollInbox();
                exportDispensing();
            }
            catch { /* shown on the Hospital system page */ }
            let every = 60;
            try {
                every = pollSeconds();
            }
            catch { /* the default */ }
            setTimeout(() => void his(), every * 1000).unref();
        };
        setTimeout(() => void his(), 5000).unref();
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
