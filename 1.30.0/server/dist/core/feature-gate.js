import { FEATURES, featureByKey, featureSettingKey } from "./features.js";
import { settingBool } from "./settings.js";
import { HttpError } from "../lib/http.js";
/** Whether a feature is on (an unknown key: on — a typo must not switch something off). */
export function featureOn(key) {
    const f = featureByKey(key);
    return f ? settingBool(featureSettingKey(f)) : true;
}
/** Every feature's state, for the screens (/api/lookups) and Admin → Features. */
export function featureStates() {
    return Object.fromEntries(FEATURES.map((f) => [f.key, settingBool(featureSettingKey(f))]));
}
/** Throws 403 feature_off when the feature is off (for checks inside a route shared by several features). */
export function requireFeature(key) {
    if (!featureOn(key))
        throw new HttpError(403, `${featureByKey(key)?.name ?? key} is turned off (Admin → Features)`, { code: "feature_off", feature: key });
}
const ROUTES = FEATURES.flatMap((f) => (f.routes ?? []).map((r) => ({
    f, methods: r.methods, also: r.also ?? [], open: !!r.open, len: r.prefix.length + (r.exact ? 0.5 : 0),
    re: new RegExp(`^${r.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z]+/g, "[^/?#]+")}${r.exact ? "/?(?=[?#]|$)" : "(?=[/?#]|$)"}`),
}))).sort((a, b) => b.len - a.len);
/** The route rule this request falls under (the most specific whose methods include it), or null. */
function ruleOf(method, url) {
    for (const r of ROUTES)
        if (r.re.test(url) && (!r.methods || r.methods.includes(method)))
            return r;
    return null;
}
/** The feature that owns this request, or null (a route of no feature, or one that is always open). */
export function featureOfRequest(method, url) {
    const r = ruleOf(method, url);
    return r && !r.open ? r.f : null;
}
/** The switched-off feature that refuses this request, or null when it may go ahead. */
export function refusingFeature(method, url) {
    const r = ruleOf(method, url);
    if (!r || r.open || featureOn(r.f.key) || r.also.some(featureOn))
        return null;
    return r.f;
}
/**
 * Refuses requests to a switched-off feature's routes, before anything else runs. Decided by the route that matched,
 * not by the URL text ("/api/stock/%68olds" reaches /api/stock/holds too). `exempt`: requests let through anyway —
 * work replayed from a pharmacy PC, done while the feature was on there, is kept rather than lost.
 */
export function featureGateHook(app, exempt) {
    app.addHook("onRequest", async (req) => {
        const url = req.routeOptions?.url;
        if (!url || exempt?.(req))
            return;
        const f = refusingFeature(req.method, url);
        if (f)
            throw new HttpError(403, `${f.name} is turned off (Admin → Features)`, { code: "feature_off", feature: f.key });
    });
}
