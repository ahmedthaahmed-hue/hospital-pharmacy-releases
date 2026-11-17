import { z } from "zod";
import { db } from "../../db/index.js";
import { audit, bad, notFound, parse, zId } from "../../lib/http.js";
import { nowIso, toLocalIso } from "../../lib/time.js";
import { OFFLINE_ID_BASE } from "../../db/versioned.js";
const ONLINE_MS = 2 * 60_000;
const msgSelect = `SELECT m.id, m.room_id AS roomId, m.from_location_id AS fromLocationId, fl.name AS fromLocationName,
    m.to_location_id AS toLocationId, tl.name AS toLocationName, m.from_user_id AS fromUserId, u.display_name AS fromUserName,
    m.body, m.created_at AS createdAt
  FROM chat_messages m
  LEFT JOIN locations fl ON fl.id = m.from_location_id
  LEFT JOIN locations tl ON tl.id = m.to_location_id
  LEFT JOIN users u ON u.id = m.from_user_id`;
/** Visible to pharmacy :loc (bind the location id twice). */
const visible = "(m.to_location_id IS NULL OR m.to_location_id = ? OR m.from_location_id = ?)";
function shape(r, loc) {
    const pharmacy = r.fromLocationName ?? "Unknown pharmacy";
    return {
        ...r,
        mine: r.fromLocationId === loc,
        private: r.toLocationId != null,
        sender: r.fromUserName ? `${pharmacy} — ${r.fromUserName}` : pharmacy,
    };
}
/**
 * The newest message id the read marker may move to. On a pharmacy PC, messages sent there have ids from the PC's own
 * range (2^48 and up, see platform/ids.ts) until its next copy from the main server, while messages from other
 * pharmacies arrive with the main server's (smaller) ids: a marker moved to a PC id would count every message still to
 * come as read. So the marker only moves to main-server ids.
 */
function readable(loc, upTo) {
    const max = db().get(`SELECT IFNULL(MAX(m.id), 0) AS id FROM chat_messages m WHERE ${visible} AND m.id < ?`, [loc, loc, OFFLINE_ID_BASE]).id;
    return Math.min(upTo, max);
}
function lastRead(loc) {
    return db().get("SELECT last_read_message_id AS id FROM chat_presence WHERE location_id=?", [loc])?.id ?? 0;
}
/** Unread for my pharmacy: public or to me, not from me, after my read marker (active rooms only). */
function unreadSummary(req) {
    const loc = req.ctx.locationId;
    const after = lastRead(loc);
    const base = `FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id AND r.active = 1
    WHERE (m.to_location_id IS NULL OR m.to_location_id = ?) AND IFNULL(m.from_location_id, -1) <> ? AND m.id > ?`;
    const count = db().get(`SELECT COUNT(*) c ${base}`, [loc, loc, after]).c;
    const latestRow = count ? db().get(`${msgSelect} WHERE m.id = (SELECT MAX(m.id) ${base})`, [loc, loc, after]) : undefined;
    return { count, lastReadId: after, latest: latestRow ? shape(latestRow, loc) : null };
}
/**
 * Presence and read markers are bookkeeping, not hospital data: they must not count as a change of the database, or every
 * open screen's 20 s heartbeat would make every pharmacy PC download a full copy of the database on every sync round.
 */
const bookkeeping = (fn) => db().untracked(fn);
function touchPresence(loc) {
    bookkeeping(() => db().run(`INSERT INTO chat_presence(location_id, last_seen, last_read_message_id) VALUES (?, ?, 0)
            ON CONFLICT(location_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`, [loc, nowIso()]));
}
export default async function routes(app) {
    app.get("/rooms", async () => db().all("SELECT id, name FROM chat_rooms WHERE active = 1 ORDER BY name"));
    /**
     * Messages of a room visible to my pharmacy, oldest → newest.
     *  - afterId: only newer messages (polling);  beforeId: the page before (load earlier);
     *  - neither: the latest `limit` messages.
     */
    app.get("/rooms/:id/messages", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        const q = parse(z.object({
            afterId: z.coerce.number().int().min(0).optional(),
            beforeId: z.coerce.number().int().min(1).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(200),
        }), req.query);
        if (!db().get("SELECT 1 FROM chat_rooms WHERE id=? AND active=1", [id]))
            throw notFound("Room");
        const loc = req.ctx.locationId;
        let rows;
        if (q.afterId !== undefined) {
            rows = db().all(`${msgSelect} WHERE m.room_id = ? AND ${visible} AND m.id > ? ORDER BY m.id LIMIT ?`, [id, loc, loc, q.afterId, q.limit]);
        }
        else {
            const before = q.beforeId ?? Number.MAX_SAFE_INTEGER;
            rows = db().all(`${msgSelect} WHERE m.room_id = ? AND ${visible} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, [id, loc, loc, before, q.limit]).reverse();
        }
        return rows.map((r) => shape(r, loc));
    });
    app.post("/rooms/:id/messages", async (req) => {
        const { id } = parse(z.object({ id: zId }), req.params);
        const b = parse(z.object({
            body: z.string().trim().min(1, "Type a message").max(2000, "The message is longer than 2000 characters"),
            toLocationId: z.coerce.number().int().positive().nullish(),
        }), req.body);
        if (!db().get("SELECT 1 FROM chat_rooms WHERE id=? AND active=1", [id]))
            throw notFound("Room");
        const loc = req.ctx.locationId;
        const to = b.toLocationId ?? null;
        if (to != null) {
            if (to === loc)
                throw bad("You cannot send a private message to your own pharmacy");
            if (!db().get("SELECT 1 FROM locations WHERE id=? AND active=1", [to]))
                throw notFound("Recipient pharmacy");
        }
        const r = db().run("INSERT INTO chat_messages(room_id, from_location_id, to_location_id, from_user_id, body, created_at) VALUES (?,?,?,?,?,?)", [id, loc, to, req.ctx.userId, b.body, nowIso()]);
        touchPresence(loc);
        // Sending implies having read everything up to here.
        db().run("UPDATE chat_presence SET last_read_message_id = MAX(last_read_message_id, ?) WHERE location_id = ?", [readable(loc, r.lastId), loc]);
        audit(req, "chat.send", "chat_message", r.lastId, { roomId: id, toLocationId: to });
        return shape(db().get(`${msgSelect} WHERE m.id = ?`, [r.lastId]), loc);
    });
    /** Presence heartbeat for my pharmacy. Returns the unread summary so the shell needs one request per poll. */
    app.post("/heartbeat", async (req) => {
        touchPresence(req.ctx.locationId);
        return unreadSummary(req);
    });
    app.get("/presence", async (req) => {
        const cutoff = toLocalIso(new Date(Date.now() - ONLINE_MS));
        return db().all(`SELECT l.id, l.name, p.last_seen AS lastSeen FROM locations l LEFT JOIN chat_presence p ON p.location_id = l.id
       WHERE l.active = 1 ORDER BY l.id`).map((r) => ({
            ...r, online: !!r.lastSeen && r.lastSeen >= cutoff, isMe: r.id === req.ctx.locationId,
        }));
    });
    app.get("/unread", async (req) => unreadSummary(req));
    /** Mark read up to `upToId` (default: newest message visible to my pharmacy). Never moves the marker back. */
    app.post("/read", async (req) => {
        const b = parse(z.object({ upToId: z.coerce.number().int().min(0).optional() }), req.body ?? {});
        const loc = req.ctx.locationId;
        const upTo = readable(loc, b.upToId ?? Number.MAX_SAFE_INTEGER);
        touchPresence(loc);
        bookkeeping(() => db().run("UPDATE chat_presence SET last_read_message_id = MAX(last_read_message_id, ?) WHERE location_id = ?", [upTo, loc]));
        return unreadSummary(req);
    });
}
