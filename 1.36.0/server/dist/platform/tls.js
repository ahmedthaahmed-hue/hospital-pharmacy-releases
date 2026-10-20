// HTTPS on the hospital network (release 1.8). The main server makes its own certificate (self-signed, ECDSA P-256,
// 10 years) the first time it starts, kept in <data>/tls/. The same port answers both: a connection that opens with a
// TLS handshake is served over TLS, anything else as before over plain HTTP (so firewall rules and bookmarks keep
// working). Pharmacy PCs get the certificate from the main server over their authenticated sync link and then talk to
// it over TLS trusting ONLY that certificate (pinned) — someone on the network can no longer read or change the sync
// traffic, and a PC that pinned it refuses any other server. Browsers on other PCs may use https://<server>:<port>
// (they warn once about the self-signed certificate, or trust it after Admin → Network → Download the certificate).
import { createHash, createHmac, generateKeyPairSync, sign, X509Certificate, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { createServer as tlsServer } from "node:tls";
import { dataPath } from "./paths.js";
/* ---------- a minimal DER writer (just what an X.509 certificate needs) ---------- */
const len = (n) => (n < 128 ? Buffer.from([n]) : (() => { const b = []; while (n > 0) {
    b.unshift(n & 255);
    n >>= 8;
} return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (b) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s) => {
    const p = s.split(".").map(Number);
    const out = [40 * p[0] + p[1]];
    for (const v of p.slice(2)) {
        const enc = [v & 127];
        for (let x = v >>> 7; x > 0; x >>>= 7)
            enc.unshift(0x80 | (x & 127));
        out.push(...enc);
    }
    return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const time = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    const y = d.getUTCFullYear();
    const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`));
};
const explicit = (n, body) => tlv(0xa0 + n, body);
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
/** The addresses the certificate names: this PC's name, localhost and its IPv4 addresses. */
export function certNames() {
    const ips = new Set(["127.0.0.1"]);
    for (const list of Object.values(networkInterfaces()))
        for (const a of list ?? [])
            if (a.family === "IPv4")
                ips.add(a.address);
    return { dns: [...new Set([hostname(), "localhost"].filter(Boolean))], ips: [...ips] };
}
/** A self-signed certificate and its key (PEM), valid for `years`. */
export function makeCertificate(commonName, names = certNames(), years = 10, now = new Date()) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
    const notAfter = new Date(now);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
    const notBefore = new Date(now.getTime() - 24 * 3600_000); // a PC whose clock is a little behind still accepts it
    const san = seq(...names.dns.map((d) => tlv(0x82, Buffer.from(d))), ...names.ips.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))));
    const exts = explicit(3, seq(seq(oid("2.5.29.17"), tlv(0x04, san)), // subjectAltName
    seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())), // basicConstraints, critical, not a CA
    seq(oid("2.5.29.37"), tlv(0x04, seq(oid("1.3.6.1.5.5.7.3.1"))))));
    const serial = randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 0x40; // positive, and no leading zero byte to trim
    const tbs = seq(explicit(0, int(Buffer.from([2]))), int(serial), ECDSA_SHA256, name, seq(time(notBefore), time(notAfter)), name, spki, exts);
    const sig = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
    const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
    return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
/** "AB:CD:…" SHA-256 of a certificate (what browsers and Admin → Network show). */
export const fingerprint = (certPem) => new X509Certificate(certPem).fingerprint256;
/**
 * The certificate's security code (release 1.32): the start of its SHA-256 fingerprint, "AB12 CD34 EF56 7890". Shown
 * on the main server (Admin → Network) and on a PC being set up, before the admin's password is sent: when they match,
 * nobody in between is answering in the main server's place.
 */
export const securityCode = (fp) => fp.replace(/[^0-9a-f]/gi, "").slice(0, 16).toUpperCase().match(/.{4}/g).join(" ");
export const certCode = (certPem) => securityCode(fingerprint(certPem));
export const certHash = (certPem) => createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
/** The main server vouches for its certificate to a pharmacy PC with the PC's own sync key (HMAC-SHA256). */
/** A refused or failed TLS connection (a certificate that is not the pinned one, or a server no longer speaking TLS). */
export const isTlsFailure = (e) => typeof e?.code === "string" && /CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/.test(e.code);
export const certMac = (syncKey, certPem) => createHmac("sha256", syncKey).update(certPem).digest("hex");
export const heartbeatMac = (syncKey, nonce, v) => createHmac("sha256", syncKey)
    .update(JSON.stringify(["hb1", nonce, v.status, v.killed, v.lockMessage, v.lockReason, v.licenceOk, v.offlineDays])).digest("hex");
/** This main server's certificate and key, made on first use. */
export function serverCertificate() {
    const dir = dataPath("tls");
    const certFile = join(dir, "server.crt"), keyFile = join(dir, "server.key");
    if (existsSync(certFile) && existsSync(keyFile)) {
        try {
            const cert = readFileSync(certFile, "utf8"), key = readFileSync(keyFile, "utf8");
            if (new X509Certificate(cert).validTo && new Date(new X509Certificate(cert).validTo) > new Date())
                return { cert, key };
        }
        catch { /* unreadable: make a new one */ }
    }
    mkdirSync(dir, { recursive: true });
    const made = makeCertificate(`Hospital Pharmacy ${hostname()}`);
    writeFileSync(keyFile, made.key, { mode: 0o600 });
    writeFileSync(certFile, made.cert);
    return made;
}
/**
 * One port, both protocols: connections that start with a TLS handshake (first byte 0x16) go through TLS to the app's
 * HTTP server; the rest go to it as they are. Listens on `port`/`host`.
 */
export function dualServer(app, tls) {
    const secure = tlsServer({ cert: tls.cert, key: tls.key, ALPNProtocols: ["http/1.1"], handshakeTimeout: 10_000 }, (s) => app.emit("connection", s));
    secure.on("tlsClientError", () => { });
    return netServer((sock) => {
        sock.on("error", () => sock.destroy());
        // a connection that never sends its first byte would otherwise stay open forever
        sock.setTimeout(10_000, () => sock.destroy());
        sock.once("data", (first) => {
            sock.setTimeout(0);
            sock.pause();
            sock.unshift(first);
            (first[0] === 0x16 ? secure : app).emit("connection", sock);
            process.nextTick(() => sock.resume());
        });
    });
}
