// What a dispensing request actually dispensed, from its JSON answer: the PC records it with the work it queues, and the
// main server compares it with what the same work dispensed there. A run or ticket that was complete on the PC but
// partly short on the main server (less stock there) is applied, and also reported, so no one assumes it was all given.
const TOP = ["dispensed", "short", "dispensedLines", "shortLines"];
const COUNTS = ["dispensed", "partial", "outOfStock", "errors"];
/** The dispensing numbers of an answer (order dispense, walk-in ticket dispense, run), or null when it has none. */
export function outcomeOf(body) {
    if (!body || body[0] !== "{" || body.length > 5_000_000)
        return null;
    let j;
    try {
        j = JSON.parse(body);
    }
    catch {
        return null;
    }
    const out = {};
    for (const k of TOP)
        if (typeof j?.[k] === "number")
            out[k] = j[k];
    const counts = j?.summary?.counts;
    if (counts && j.summary.dispense)
        for (const k of COUNTS)
            if (typeof counts[k] === "number")
                out[`counts.${k}`] = counts[k];
    return Object.keys(out).length ? out : null;
}
/** How the main server's outcome differs from the PC's, in words; null when it dispensed the same. */
export function outcomeDifference(pc, main) {
    const diff = Object.keys(pc).filter((k) => (main?.[k] ?? null) !== pc[k]);
    if (!diff.length)
        return null;
    const show = (o) => diff.map((k) => `${k} ${o?.[k] ?? "—"}`).join(", ");
    return `Applied on the main server, but it could not dispense the same there (on this PC: ${show(pc)}; on the main server: ${show(main)}) — check the stock and dispense what is missing`;
}
/**
 * Replayed dispensing that the main server could not take from the batches the PC gave (core/fefo.ts dispenseFEFO: a
 * batch used up, missing, expired or held there), in words; null when every batch was the PC's. The packs that left
 * the shelf were the PC's batches, while the main server's records — which a recall searches — name others.
 */
export function batchDifference(diffs, more = 0) {
    if (!diffs.length)
        return null;
    const extra = Math.max(0, diffs.length - 10) + more;
    const shown = diffs.slice(0, 10).join("; ") + (extra ? `; and ${extra} more` : "");
    return `Applied on the main server, but not all from the batches this PC gave — ${shown}. `
        + "The packs given were this PC's batches: check the stock of these batches, and remember that a recall finds patients by the batches recorded on the main server";
}
