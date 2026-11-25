// Finding the main server on the hospital network: for the first-run setup of a pharmacy PC, and (1.64) for a
// pharmacy PC whose main server has changed address since (a new IP from the network, DHCP).
//
// Two ways, run together:
//   - A broadcast question (UDP, port 41080, HPS_DISCOVERY_PORT): sent on each of this PC's networks, answered at once
//     by any main server that hears it, however wide the network is (a 255.255.0.0 mask holds 65,000 addresses). It
//     needs a network that carries broadcasts and the main server's firewall to let it in (setup-pc.ps1, launch.ps1).
//   - A sweep: address after address is asked, on the main server's port, whether it is a main server
//     (/api/system/info, public). It starts with this PC's own block of 256 addresses and goes outward, nearest first,
//     through this PC's whole network at its real mask and a few blocks beyond it (a router may join two neighbouring
//     networks: the main server at 175.0.0.6, this PC at 175.0.1.125). At most 128 addresses at a time, each given half
//     a second, and a fixed number in all, so it never floods the network.
// Every answer is checked over HTTP before it is listed, and a main server reachable at several addresses is listed
// once. Anyone can answer as a "main server" here: what proves it is the real one is its certificate (pinned once a
// PC is connected, the security code before) — findMovedServer below checks it.
import { createSocket } from "node:dgram";
import { connect as tcpConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { certHash } from "./tls.js";
/* ---------- addresses ---------- */
export function ipToInt(ip) {
    const p = ip.trim().split(".");
    if (p.length !== 4)
        return null;
    let n = 0;
    for (const s of p) {
        if (!/^\d{1,3}$/.test(s) || Number(s) > 255)
            return null;
        n = n * 256 + Number(s);
    }
    return n;
}
export const intToIp = (n) => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");
/** The number of leading one bits of a mask such as 255.255.254.0 (23); null when it is not a mask. */
export function maskBits(mask) {
    const m = ipToInt(mask);
    if (m === null)
        return null;
    const bits = m.toString(2).padStart(32, "0");
    return /^1*0*$/.test(bits) ? bits.indexOf("0") === -1 ? 32 : bits.indexOf("0") : null;
}
/** An address a main server could have: not 0.x, not link-local (169.254.x), not multicast or reserved (224 and up). */
const usable = (n) => n >= 16777216 && n < 3758096384 && Math.floor(n / 65536) !== 43518;
/** This PC's IPv4 networks (no loopback, no link-local), with their real masks. */
export function localAdapters() {
    const out = [];
    for (const list of Object.values(networkInterfaces()))
        for (const n of list ?? [])
            if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254."))
                out.push({ address: n.address, netmask: n.netmask });
    return out.filter((a, i) => out.findIndex((b) => b.address === a.address) === i);
}
/**
 * The addresses to sweep, in order: the seeds, then for each network of this PC its own block of 256, then the
 * blocks next to it on either side, then the next ones out, and so on (all networks taken in turn at each distance),
 * as far as the network's mask reaches plus `beyondMask` blocks, up to `maxDistance` and `limit`. The network's own
 * network and broadcast addresses are left out, and so are .0 and .255 except inside a network wider than 256.
 */
export function sweepPlan(adapters, o) {
    const beyond = o.beyondMask ?? 3;
    const sources = [];
    const source = (a, bits) => {
        const size = 2 ** (32 - bits);
        const net = a - (a % size), bc = net + size - 1, block = Math.floor(a / 256);
        sources.push({ block, net, bc, wide: bits < 24,
            lo: Math.max(0, Math.floor(net / 256) - beyond), hi: Math.min(16777215, Math.floor(bc / 256) + beyond) });
    };
    const out = [];
    const seen = new Set();
    const add = (n) => { if (out.length < o.limit && usable(n) && !seen.has(n)) {
        seen.add(n);
        out.push(intToIp(n));
    } };
    for (const s of o.seeds ?? []) {
        const a = ipToInt(s);
        if (a !== null && usable(a)) {
            add(a);
            source(a, 24);
        }
    }
    for (const ad of adapters) {
        const a = ipToInt(ad.address);
        if (a === null || !usable(a))
            continue;
        // a mask wider than a /16 would be hundreds of blocks: the limit stops the sweep long before, nearest first
        source(a, Math.max(8, Math.min(32, maskBits(ad.netmask) ?? 24)));
    }
    for (let d = 0; d <= o.maxDistance && out.length < o.limit; d++) {
        for (const s of sources) {
            for (const b of d === 0 ? [s.block] : [s.block + d, s.block - d]) {
                if (b < s.lo || b > s.hi)
                    continue;
                for (let i = 0; i < 256; i++) {
                    const n = b * 256 + i;
                    const inside = n >= s.net && n <= s.bc;
                    if (inside && (n === s.net || n === s.bc) && s.bc - s.net > 1)
                        continue;
                    if ((i === 0 || i === 255) && !(inside && s.wide))
                        continue;
                    add(n);
                }
            }
        }
    }
    return out;
}
/** The sweep's settings for each pass: "near" first (a few seconds), "wide" only if nothing was found near. */
export const PASSES = {
    near: { maxDistance: 1, limit: 2048 },
    wide: { maxDistance: 16, limit: 4096 },
};
export function planFor(mode, adapters, seeds) {
    const near = sweepPlan(adapters, { ...PASSES.near, seeds });
    if (mode === "near")
        return near;
    const wide = sweepPlan(adapters, { ...PASSES.wide, seeds });
    if (mode === "all")
        return wide;
    const done = new Set(near);
    return wide.filter((h) => !done.has(h));
}
/* ---------- asking one address ---------- */
/** Whether something listens at host:port (a quick TCP connect, given up after timeoutMs). */
export function portOpen(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = tcpConnect({ host, port });
        const done = (ok) => { clearTimeout(t); s.destroy(); resolve(ok); };
        const t = setTimeout(() => done(false), timeoutMs);
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
    });
}
/** The main server at this address (http://host:port), or null when nothing there says it is one. */
export async function serverAt(base, timeoutMs = 2500) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
        const r = await fetch(`${base}/api/system/info`, { signal: c.signal });
        if (!r.ok)
            return null;
        const j = await r.json();
        if (j?.app !== "hospital-pharmacy" || j.role !== "server")
            return null;
        return { url: base, name: String(j.name ?? new URL(base).hostname).slice(0, 80), version: String(j.version ?? "").slice(0, 40),
            nodeUuid: typeof j.nodeUuid === "string" ? j.nodeUuid : null };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
/* ---------- the broadcast question ---------- */
const ASK = "HPS-DISCOVER/1 ";
/** The question is as long as the longest answer, so answering never sends more than was received. */
export const PACKET_BYTES = 512;
export function discoveryPort() {
    const v = process.env.HPS_DISCOVERY_PORT;
    if (v === undefined || v === "")
        return 41080;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; // "off", "0": no broadcast question or answer
}
export function askPacket(nonce) {
    const b = Buffer.alloc(PACKET_BYTES, 0x20);
    b.write(ASK + nonce, "latin1");
    return b;
}
/** The question's nonce, or null when this is not a well-formed question. */
export function parseAsk(msg) {
    if (msg.length !== PACKET_BYTES)
        return null;
    return /^HPS-DISCOVER\/1 ([0-9a-f]{32}) *$/.exec(msg.toString("latin1"))?.[1] ?? null;
}
export function answerPacket(nonce, me) {
    const body = (addresses, name) => Buffer.from(JSON.stringify({ app: "hospital-pharmacy", v: 1, nonce, role: me.role,
        name, version: me.version, nodeUuid: me.nodeUuid, port: me.port, addresses }), "utf8");
    let b = body(me.addresses.slice(0, 8), me.name);
    if (b.length > PACKET_BYTES)
        b = body([], me.name);
    if (b.length > PACKET_BYTES)
        b = body([], me.name.slice(0, 20));
    return b;
}
export function parseAnswer(msg, nonce, from) {
    try {
        const j = JSON.parse(msg.toString("utf8"));
        if (j?.app !== "hospital-pharmacy" || j.nonce !== nonce || j.role !== "server")
            return null;
        const port = Number(j.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            return null;
        const addresses = Array.isArray(j.addresses) ? j.addresses.filter((a) => typeof a === "string" && ipToInt(a) !== null).slice(0, 8) : [];
        return { address: from, port, addresses };
    }
    catch {
        return null;
    }
}
let responder = null;
/**
 * The main server's side: answer the broadcast question with what /api/system/info already tells anyone (name,
 * version, id) and the port. Only well-formed questions, at most 20 answers a second and 3 per asking PC.
 * Resolves with the port it listens on, or null (turned off, or the port taken: the sweep still finds this server).
 */
export function startDiscoveryResponder(me, port = discoveryPort()) {
    if (responder || port === null)
        return Promise.resolve(null);
    const sock = createSocket({ type: "udp4" });
    responder = sock;
    let windowStart = 0, inWindow = 0;
    const perPc = new Map();
    sock.on("message", (msg, from) => {
        const nonce = parseAsk(msg);
        if (!nonce)
            return;
        const now = Date.now();
        if (now - windowStart >= 1000) {
            windowStart = now;
            inWindow = 0;
            perPc.clear();
        }
        const mine = perPc.get(from.address) ?? 0;
        if (inWindow >= 20 || mine >= 3)
            return;
        let info;
        try {
            info = me();
        }
        catch {
            return;
        }
        if (info.role !== "server")
            return;
        inWindow++;
        perPc.set(from.address, mine + 1);
        sock.send(answerPacket(nonce, info), from.port, from.address, () => { });
    });
    return new Promise((resolve) => {
        sock.once("error", (e) => {
            console.warn(`[discovery] cannot answer the network search on UDP ${port} (${e.message}); pharmacy PCs still find this server by its port`);
            try {
                sock.close();
            }
            catch { /* closed */ }
            if (responder === sock)
                responder = null;
            resolve(null);
        });
        sock.bind(port, () => { sock.unref(); resolve(sock.address().port); });
    });
}
export function stopDiscoveryResponder() {
    const s = responder;
    responder = null;
    if (s)
        try {
            s.close();
        }
        catch { /* closed */ }
}
/**
 * Ask by broadcast on each network (from a socket on that network's own address, so the question goes out of every
 * adapter), and to `direct` addresses (tests). Collects answers for waitMs.
 */
export async function askByBroadcast(o) {
    const nonce = randomBytes(16).toString("hex");
    const packet = askPacket(nonce);
    const answers = new Map();
    const sockets = [];
    const open = (bindTo, targets) => new Promise((resolve) => {
        const s = createSocket({ type: "udp4" });
        sockets.push(s);
        s.on("error", () => resolve());
        s.on("message", (msg, from) => { const a = parseAnswer(msg, nonce, from.address); if (a && !answers.has(a.address))
            answers.set(a.address, a); });
        s.bind({ address: bindTo, port: 0 }, () => {
            try {
                s.setBroadcast(true);
            }
            catch { /* not allowed: the direct targets still go */ }
            for (const t of targets)
                s.send(packet, o.port, t, () => { });
            resolve();
        });
    });
    const jobs = [];
    for (const a of o.adapters) {
        const ip = ipToInt(a.address), bits = maskBits(a.netmask);
        if (ip === null)
            continue;
        const targets = ["255.255.255.255"];
        if (bits !== null && bits < 31) {
            const size = 2 ** (32 - bits);
            targets.push(intToIp(ip - (ip % size) + size - 1));
        }
        jobs.push(open(a.address, targets));
    }
    if (o.direct?.length)
        jobs.push(open(undefined, o.direct));
    await Promise.all(jobs);
    await new Promise((r) => setTimeout(r, o.waitMs ?? 1200));
    for (const s of sockets)
        try {
            s.close();
        }
        catch { /* closed */ }
    return [...answers.values()];
}
export async function findServers(o) {
    const adapters = o.adapters ?? localAdapters();
    const port = o.port ?? Number(process.env.HPS_SERVER_PORT ?? 8080);
    const hosts = o.plan ? sweepPlan(adapters, { ...o.plan, seeds: o.seeds }) : planFor(o.mode, adapters, o.seeds);
    // one entry per server (by its id: a server on two networks answers at two addresses), first address found
    const found = new Map();
    let accepted = null;
    const take = async (s) => {
        if (!s || accepted)
            return;
        // (each address is checked once: the same server at another address may be the one that proves itself)
        const key = o.accept ? s.url : s.nodeUuid ?? s.url;
        if (found.has(key))
            return;
        found.set(key, s);
        if (o.accept && await o.accept(s) && !accepted)
            accepted = s;
    };
    const udpPort = o.discoveryPort ?? discoveryPort();
    // (the "wide" pass follows a "near" one, which asked already)
    const asking = o.broadcast === false || udpPort === null || o.mode === "wide" ? Promise.resolve() : askByBroadcast({ adapters, port: udpPort, direct: o.direct })
        .then(async (answers) => {
        for (const a of answers) {
            let s = await serverAt(`http://${a.address}:${a.port}`);
            for (const other of a.addresses)
                if (!s && other !== a.address)
                    s = await serverAt(`http://${other}:${a.port}`, 1500);
            await take(s);
        }
    }).catch(() => { });
    let next = 0;
    const timeoutMs = o.timeoutMs ?? 500;
    const worker = async () => {
        while (next < hosts.length && !accepted) {
            const h = hosts[next++];
            if (await portOpen(h, port, timeoutMs))
                await take(await serverAt(`http://${h}:${port}`));
        }
    };
    await Promise.all([asking, ...Array.from({ length: Math.min(o.concurrency ?? 128, hosts.length) }, worker)]);
    const servers = accepted ? [accepted] : o.accept ? [] : [...found.values()];
    return {
        servers: servers.sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true })),
        searched: { networks: adapters.map((a) => `${a.address}/${maskBits(a.netmask) ?? 24}`), addresses: hosts.length },
    };
}
/**
 * Where the main server this PC is connected to is now, when it is no longer at its address: a main server that shows
 * the very certificate this PC pinned (only the real main server holds its key). Its id is public, so it proves
 * nothing and is not required: a main server restored onto a new install has a new id but may keep its certificate.
 * Nothing secret is sent to any candidate. Returns its new address (https://…), or null.
 */
export async function findMovedServer(o) {
    let old;
    try {
        old = new URL(o.serverUrl);
    }
    catch {
        return null;
    }
    const port = Number(old.port || 8080);
    const want = certHash(o.pinnedCert);
    const r = await (o.find ?? findServers)({ mode: "all", port, seeds: ipToInt(old.hostname) !== null ? [old.hostname] : [], adapters: o.adapters,
        accept: async (s) => {
            const cert = await o.certAt(s.url.replace(/^http:/i, "https:")).catch(() => null);
            try {
                return !!cert && certHash(cert) === want;
            }
            catch {
                return false;
            }
        } });
    return r.servers[0] ? r.servers[0].url.replace(/^http:/i, "https:") : null;
}
