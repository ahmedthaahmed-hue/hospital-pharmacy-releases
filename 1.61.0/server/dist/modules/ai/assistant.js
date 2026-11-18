// The online assistant and prescription photo reading (release 1.15, plan items 43 and 44), through the Claude API.
// Both are off until the hospital turns them on (Admin → Features) and an administrator saves an API key (Admin → Online
// assistant); both need the main server to reach the internet.
//
//   Ask        a question in Arabic or English about the pharmacy's work, answered from totals only: the model reads the
//              data through tools.ts, which never return a patient's name or ID (nothing identifying a patient leaves).
//   Read Rx    a walk-in prescription's photo, read into lines (drug as written, dose, how often, how long) for the
//              pharmacist to check and match to items. The photo itself does leave the hospital — the screen says so
//              and asks first, every time — and nothing is saved from it.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../../db/index.js";
import { settingStr } from "../../core/settings.js";
import { HttpError } from "../../lib/http.js";
import { now, toLocalDate } from "../../lib/time.js";
import { runTool, toolsFor } from "./tools.js";
const META = (k) => db().get("SELECT value FROM schema_meta WHERE key = ?", [k])?.value;
const SET = (k, v) => (v == null ? db().run("DELETE FROM schema_meta WHERE key = ?", [k]) : db().run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", [k, v]));
/** The API key: saved by an administrator, never sent back to a screen (only its last four characters). */
export const apiKeySet = () => !!META("ai_api_key");
export const apiKeyHint = () => { const k = META("ai_api_key"); return k ? `…${k.slice(-4)}` : null; };
export function setApiKey(key) { SET("ai_api_key", key); client = null; }
let client = null;
let testClient = null;
/** Tests only: a stand-in for the Claude API. */
export function setClientForTests(c) { testClient = c; }
function api() {
    if (testClient)
        return testClient;
    const key = META("ai_api_key");
    if (!key)
        throw new HttpError(409, "No API key is saved (Admin → Online assistant)");
    // a round that takes longer than this is reported as busy, not left waiting (one retry: at most a few minutes in all)
    return (client ??= new Anthropic({ apiKey: key, timeout: 90_000, maxRetries: 1 }));
}
export const model = () => settingStr("ai.model") || "claude-opus-5-5";
const effort = () => (["low", "medium", "high"].includes(settingStr("ai.effort")) ? settingStr("ai.effort") : "medium");
/** A request declined for policy reasons is retried on Anthropic's recommended model for that kind of decline (not for Haiku). */
const fallback = () => (model().includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
/** A refusal or an API failure, said plainly. */
function failure(e) {
    if (e instanceof HttpError)
        throw e;
    if (e instanceof Anthropic.AuthenticationError)
        throw new HttpError(502, "The API key was not accepted (Admin → Online assistant)");
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionTimeoutError)
        throw new HttpError(503, "The assistant is busy — try again in a minute");
    if (e instanceof Anthropic.APIConnectionError)
        throw new HttpError(503, "The main server could not reach the assistant online — check its internet connection");
    if (e instanceof Anthropic.APIError)
        throw new HttpError(502, `The assistant answered with an error (${e.status ?? "?"})`);
    throw e;
}
const SYSTEM = `You help the pharmacists of a hospital pharmacy understand their own work: dispensing, stock, patients per department, safety warnings, orders.
Answer in the language of the question (Arabic or English), briefly and concretely, with the numbers. Use the tools to look the numbers up; never guess them. If the tools cannot answer, say what is missing.
You only ever see totals: you have no access to any patient's name, ID or records, and must not ask for them. If asked about one patient, say that you only see totals.
Medicine and department names may be in Arabic; keep them as written.`;
/** Answers a question (with the conversation so far), looking numbers up through the totals-only tools. */
export async function ask(question, history, scope) {
    const messages = [
        ...history.slice(-10).map((t) => ({ role: t.role, content: t.text })),
        { role: "user", content: question },
    ];
    const system = `${SYSTEM}\nToday is ${toLocalDate(now())}.${scope.everywhere ? " This user works in every pharmacy (all_pharmacies may be true for dispensing and patients; stock, warnings and orders are always this user's own pharmacy — say so)." : " Only this user's own pharmacy is available (all_pharmacies must be false)."}`;
    const used = [];
    try {
        for (let round = 0; round < 8; round++) {
            const r = await api().beta.messages.create({
                model: model(), max_tokens: 16000, system, messages, tools: toolsFor(scope),
                thinking: { type: "adaptive" }, output_config: { effort: effort() }, ...fallback(),
            });
            if (r.stop_reason === "refusal")
                return { answer: "The assistant would not answer this question.", tools: used };
            messages.push({ role: "assistant", content: r.content });
            const calls = r.content.filter((b) => b.type === "tool_use");
            if (r.stop_reason !== "tool_use" || !calls.length) {
                const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
                // an answer cut off by its length is said to be incomplete, not passed off as whole
                const cut = r.stop_reason === "max_tokens" || r.stop_reason === "model_context_window_exceeded";
                return { answer: (text || "No answer came back.") + (cut ? "\n\n(The answer was cut short — ask something narrower.)" : ""), tools: used };
            }
            messages.push({ role: "user", content: calls.map((c) => {
                    used.push(c.name);
                    let content;
                    try {
                        content = runTool(c.name, (c.input ?? {}), scope);
                    }
                    catch (e) {
                        return { type: "tool_result", tool_use_id: c.id, content: `Error: ${String(e?.message ?? e)}`, is_error: true };
                    }
                    return { type: "tool_result", tool_use_id: c.id, content };
                }) });
        }
        return { answer: "The question needed too many look-ups — ask something narrower.", tools: used };
    }
    catch (e) {
        failure(e);
    }
}
const RX_SCHEMA = {
    type: "object", additionalProperties: false, required: ["lines", "legible"],
    properties: {
        legible: { type: "boolean", description: "false when the photo is not a prescription or cannot be read" },
        lines: { type: "array", items: { type: "object", additionalProperties: false,
                required: ["drug", "strength", "dose", "frequency", "every_hours", "days", "route", "quantity", "notes"],
                properties: {
                    drug: { type: "string", description: "The medicine exactly as written (brand or generic, Arabic or Latin)" },
                    strength: { type: ["string", "null"] }, dose: { type: ["string", "null"], description: "How much per dose, e.g. 1 tab, 5 ml" },
                    frequency: { type: ["string", "null"], description: "As written, e.g. 1x3, BID, كل 8 ساعات" },
                    every_hours: { type: ["number", "null"], description: "Hours between doses when clear (8 for three times a day)" },
                    days: { type: ["number", "null"] }, route: { type: ["string", "null"] }, quantity: { type: ["string", "null"], description: "Number of packs if written" },
                    notes: { type: ["string", "null"], description: "Other instructions, e.g. after meals" }
                } } },
    },
};
/** Reads the medicine lines of a prescription photo. The patient's name and the doctor's are not asked for or returned. */
export async function readPrescription(imageBase64, mediaType) {
    try {
        const r = await api().beta.messages.create({
            model: model(), max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: effort(), format: { type: "json_schema", schema: RX_SCHEMA } },
            ...fallback(),
            messages: [{ role: "user", content: [
                        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
                        { type: "text", text: "This is a doctor's prescription for a hospital pharmacy (often Egyptian, Arabic and Latin). List each medicine line as written. Do not include the patient's or the doctor's name. If something is unclear, write what you can read and leave the rest null; never invent a medicine." },
                    ] }],
        });
        if (r.stop_reason === "refusal")
            throw new HttpError(422, "The photo could not be read");
        const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        const out = JSON.parse(text);
        return { legible: !!out.legible, lines: Array.isArray(out.lines) ? out.lines.slice(0, 30) : [] };
    }
    catch (e) {
        if (e instanceof SyntaxError)
            throw new HttpError(502, "The assistant's answer could not be read");
        failure(e);
    }
}
