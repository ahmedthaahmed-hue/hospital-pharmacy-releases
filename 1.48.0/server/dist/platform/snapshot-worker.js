// The worker that makes a pharmacy PC's copy of the database (platform/snapshot.ts), so the main server's own thread
// keeps answering meanwhile.
import { parentPort, workerData } from "node:worker_threads";
import { buildSnapshotFile } from "./snapshot.js";
const { plan, tmp } = workerData;
try {
    buildSnapshotFile(plan, tmp);
    parentPort.postMessage({ ok: true });
}
catch (e) {
    parentPort.postMessage({ ok: false, error: e?.message ?? String(e) });
}
