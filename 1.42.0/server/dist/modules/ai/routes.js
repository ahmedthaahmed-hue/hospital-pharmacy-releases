import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, can, HttpError, parse, requirePerm } from "../../lib/http.js";
import { featureOn, requireFeature } from "../../core/feature-gate.js";
import { nodeConfig } from "../../platform/node-config.js";
import { apiKeyHint, apiKeySet, ask, model, readPrescription, setApiKey } from "./assistant.js";
const onMain = () => { if (nodeConfig().role === "pharmacy")
    throw new HttpError(409, "The assistant works on the main server: open the main server's address to use it", { code: "use_main_server" }); };
const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
/** Items a written drug name may be: the same name or selection name first, then names, ingredients that contain its words. */
function candidates(drug) {
    const words = drug.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 3).slice(0, 3);
    if (!words.length)
        return [];
    // each word counts 1 where it is found (a column with nothing in it is not a match, rather than making the sum nothing)
    const one = "(IFNULL(i.name, '') LIKE ? ESCAPE '\\' OR IFNULL(i.selection_name, '') LIKE ? ESCAPE '\\' OR IFNULL(i.active_ingredient, '') LIKE ? ESCAPE '\\')";
    const args = words.flatMap((w) => [like(w), like(w), like(w)]);
    // the most words in common first, then the shortest name (the plainest match)
    return db().all(`SELECT id, name, selectionName FROM (
      SELECT i.id, i.name, i.selection_name AS selectionName, ${words.map(() => one).join(" + ")} AS score FROM items i WHERE i.active = 1)
    WHERE score > 0 ORDER BY score DESC, length(name) LIMIT 5`, args);
}
export default async function aiRoutes(app) {
    // whether it is set up (the key's last four characters for administrators only)
    app.get("/", async (req) => ({ keySet: apiKeySet(), keyHint: can(req.ctx, "admin.settings") ? apiKeyHint() : null, model: model(),
        assistant: featureOn("ai_assistant"), rxPhoto: featureOn("rx_photo") }));
    app.put("/key", async (req) => {
        requirePerm(req, "admin.settings");
        onMain();
        const { key } = parse(z.object({ key: z.string().trim().min(20, "That does not look like an API key").max(300).nullable() }), req.body);
        setApiKey(key);
        audit(req, key ? "ai.key.set" : "ai.key.remove", "ai", null, key ? { hint: `…${key.slice(-4)}` } : undefined);
        return { keySet: !!key, keyHint: apiKeyHint() };
    });
    app.post("/ask", async (req) => {
        requireFeature("ai_assistant");
        // the same totals as the Analytics screen: for those who may see it
        requirePerm(req, "analytics");
        onMain();
        const b = parse(z.object({ question: z.string().trim().min(2, "Write a question").max(2000),
            history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).max(200).default([]) }), req.body);
        // the conversation so far: its last turns only, each cut to length (a long one never stops the next question)
        const history = b.history.slice(-10).map((t) => ({ role: t.role, text: t.text.slice(0, 8000) }));
        // logged before it is sent: what leaves the hospital is on record even when the answer fails
        audit(req, "ai.ask", "ai", null, { question: b.question.slice(0, 300), history: history.length });
        return ask(b.question, history, { locationId: req.ctx.locationId, everywhere: can(req.ctx, "pharmacies.all"),
            alerts: can(req.ctx, "reports") && featureOn("alert_log") });
    });
    app.post("/read-prescription", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
        requireFeature("rx_photo");
        requirePerm(req, "walkin");
        onMain();
        const b = parse(z.object({ image: z.string().min(100).max(11 * 1024 * 1024), mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
            consent: z.literal(true, { message: "Confirm that the photo may be sent to the assistant online" }) }), req.body);
        const image = b.image.replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image))
            throw bad("The photo must be sent as base64");
        const bytes = Buffer.from(image, "base64");
        if (bytes.length > 5 * 1024 * 1024)
            throw bad("The photo is too large: take it again, or send a smaller one");
        const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.subarray(0, 4).toString("hex") === "89504e47" ? "image/png"
            : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
        if (kind !== b.mediaType)
            throw bad("This file is not a photo that can be opened");
        // logged before it is sent (the photo leaves the hospital even if reading it fails): who, and when — never the photo
        audit(req, "ai.read_prescription", "ai", null, { bytes: bytes.length });
        const r = await readPrescription(image, b.mediaType);
        return { legible: r.legible, lines: r.lines.map((l) => ({ ...l, candidates: candidates(l.drug) })) };
    });
}
