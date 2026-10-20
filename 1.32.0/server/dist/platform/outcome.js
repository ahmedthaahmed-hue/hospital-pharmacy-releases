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
