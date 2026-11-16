import { z } from "zod";
import { db } from "../../db/index.js";
import { HttpError, audit, notFound, parse, zId } from "../../lib/http.js";
import { requireFeature } from "../../core/feature-gate.js";
import { confirmLink, linkState, phoneAppUrl, phonesAvailable, relayContact, relayUrl, removeDevice, startLink } from "../../platform/phone.js";
const fromPc = (req) => {
    if (req.ctx.deviceId)
        throw new HttpError(403, "Link and remove phones from a PC", { code: "from_pc_only" });
};
const mayPhone = (req) => {
    if (!req.ctx.owner && !req.ctx.perms.has("phone"))
        throw new HttpError(403, "Your role does not include the phone app");
};
const DEVICE_COLS = "d.id, d.name, d.code, d.status, d.created_at AS createdAt, d.confirmed_at AS confirmedAt, d.last_seen_at AS lastSeenAt";
export default async function phoneRoutes(app) {
    app.get("/", async (req) => {
        fromPc(req);
        return {
            available: phonesAvailable(), relay: relayUrl(), appUrl: phoneAppUrl(), contact: relayContact, allowed: req.ctx.owner || req.ctx.perms.has("phone"),
            devices: db().all(`SELECT ${DEVICE_COLS} FROM phone_devices d WHERE d.user_id = ? AND d.status != 'removed' ORDER BY d.id`, [req.ctx.userId]),
        };
    });
    app.post("/link", async (req) => {
        fromPc(req);
        mayPhone(req);
        requireFeature("phone_app");
        if (!phonesAvailable())
            throw new HttpError(409, "Phones cannot be linked yet: the system's owner has not published a relay address", { code: "no_relay" });
        const l = await startLink(req.ctx.userId);
        audit(req, "phone.link.start", "phone_link", l.linkId);
        return l;
    });
    app.get("/link/:id", async (req) => {
        fromPc(req);
        const { id } = parse(z.object({ id: z.string().min(4).max(40) }), req.params);
        const s = linkState(id, req.ctx.userId);
        if (!s)
            notFound("Link");
        return s;
    });
    app.post("/link/:id/confirm", async (req) => {
        fromPc(req);
        mayPhone(req);
        requireFeature("phone_app");
        const { id } = parse(z.object({ id: z.string().min(4).max(40) }), req.params);
        const deviceId = confirmLink(id, req.ctx.userId);
        if (!deviceId)
            throw new HttpError(409, "No phone is waiting on this link (it may have expired)", { code: "nothing_to_confirm" });
        audit(req, "phone.link.confirm", "phone_device", deviceId);
        return { ok: true, deviceId };
    });
    app.delete("/devices/:id", async (req) => {
        fromPc(req);
        if (!req.ctx.owner && !req.ctx.perms.has("phone") && !req.ctx.perms.has("admin.users"))
            throw new HttpError(403, "Your role does not include the phone app");
        const { id } = parse(z.object({ id: zId }), req.params);
        const d = db().get("SELECT user_id FROM phone_devices WHERE id = ? AND status != 'removed'", [id]);
        if (!d)
            notFound("Phone");
        if (d.user_id !== req.ctx.userId && !req.ctx.perms.has("admin.users"))
            throw new HttpError(403, "Only its user or an admin can remove this phone");
        removeDevice(id);
        audit(req, "phone.remove", "phone_device", id);
        return { ok: true };
    });
    app.get("/all", async (req) => {
        fromPc(req);
        if (!req.ctx.perms.has("admin.users"))
            throw new HttpError(403, "Your role does not allow managing user accounts");
        return db().all(`SELECT ${DEVICE_COLS}, u.username, u.display_name AS displayName FROM phone_devices d JOIN users u ON u.id = d.user_id
      WHERE d.status != 'removed' ORDER BY u.username, d.id`);
    });
}
