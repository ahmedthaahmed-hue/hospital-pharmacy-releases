// "Now" for the current request, and what else belongs to just that request. Work a pharmacy PC did offline is replayed
// on the main server later; while a replayed request runs, now() is the time the pharmacist actually did it, so dispense
// times, medical days and audit entries are the real ones.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
const store = new AsyncLocalStorage();
export function now() { const s = store.getStore(); return s?.at ? new Date(s.at) : new Date(); }
export const currentScope = () => store.getStore();
/** The user the current request works as, or null (no request, or not signed in yet). */
export const currentUserId = () => store.getStore()?.userId ?? null;
/**
 * Runs fn — and everything it starts, e.g. an app.inject request — with the clock set to `at`. (Not enterWith: that
 * leaks the replayed time into the caller and every later request of the same chain.)
 */
export function withClock(at, fn) { return store.run({ at }, fn); }
/** Runs fn — and everything it starts — in its own request scope. */
export function withScope(scope, fn) { return store.run(scope, fn); }
/**
 * A new id for a dispensing run (text ids, which the PC's id range cannot cover). Replayed work takes the ids the
 * pharmacy PC gave its runs, so a run made there offline is the same run here — reprinting it by its id still works.
 */
export function newRunId() {
    const s = store.getStore();
    const id = s?.reuseUuids?.shift() ?? randomUUID();
    if (s?.uuids && s.uuids.length < 1000)
        s.uuids.push(id);
    return id;
}
const RESOURCE = Symbol("request-scope");
/**
 * Gives every request its own scope, for all its hooks and its handler. A request the server sends itself inside a
 * scope (replay through app.inject) keeps that scope. Fastify runs the hooks after the body is read in the context of
 * the body's stream, so the scope is entered again there (the pattern of @fastify/request-context).
 */
export function requestScopeHooks(app) {
    app.addHook("onRequest", (req, _reply, done) => {
        store.run(store.getStore() ?? { created: [], uuids: [] }, () => {
            req[RESOURCE] = new AsyncResource("hps-request-scope");
            done();
        });
    });
    app.addHook("preValidation", (req, _reply, done) => {
        const r = req[RESOURCE];
        if (r)
            r.runInAsyncScope(done, req.raw);
        else
            done();
    });
}
