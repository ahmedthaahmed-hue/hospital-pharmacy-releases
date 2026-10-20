// The app version (root package.json of the install), shown in Admin and compared during updates and sync.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
let v = null;
export function appVersion() {
    if (v)
        return v;
    const here = dirname(fileURLToPath(import.meta.url));
    for (const p of [join(here, "../../../package.json"), join(here, "../../package.json")]) {
        try {
            const j = JSON.parse(readFileSync(p, "utf8"));
            if (j.name === "hospital-pharmacy-system")
                return (v = String(j.version));
        }
        catch { /* next */ }
    }
    return (v = "0.0.0");
}
/** -1 / 0 / 1 comparing dotted versions ("2.1.0" < "2.10.0"). */
export function compareVersions(a, b) {
    const x = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0), y = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d)
            return Math.sign(d);
    }
    return 0;
}
