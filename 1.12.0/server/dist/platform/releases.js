// Signed updates and the remote off switch.
// A separate PUBLIC repository holds, for the whole system, a signed control file and signed release packages. Nothing
// there is secret: no source, no data. Each file is signed with a private key only the owner has (tools/release); this
// app carries only the matching PUBLIC key and trusts a file only when its signature verifies. So an update or an
// off-switch command is obeyed only when it is really the owner's.
//   control.json         { latestVersion, minVersion, killed, message, publishedAt }  -> <control>.sig next to it
//   <version>/manifest.json  { version, files:[{path, sha256, bytes}], publishedAt }   -> manifest.json.sig
//   <version>/<files...>     the app files for that version
// The MAIN SERVER checks the control file on the internet on a schedule; pharmacy PCs learn the result from the main
// server (so only the main server needs internet). "killed" locks every PC; the database is left untouched (encrypted).
import { verify as edVerify } from "node:crypto";
/**
 * Release signing public key (Ed25519, SPKI base64). The private key is held only by the system owner.
 * deploy/Install.ps1 carries a copy ($PublicKey) to check the first download: change both together.
 */
export const RELEASE_PUBLIC_KEY_SPKI_B64 = "MCowBQYDK2VwAyEAIbNP38wkYBwniivmxSHCsgIgen334969+63vlzB/elM=";
/** Where signed releases live. A public GitHub repo's raw content by default; override with RELEASES_URL. */
export const releasesBase = () => (process.env.RELEASES_URL ?? "https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main").replace(/\/+$/, "");
function publicKey() {
    return { key: Buffer.from(RELEASE_PUBLIC_KEY_SPKI_B64, "base64"), format: "der", type: "spki" };
}
/** True when sig (base64) is a valid signature of bytes by the release key. */
export function verifySignature(bytes, sigB64) {
    try {
        return edVerify(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), publicKey(), Buffer.from(sigB64, "base64"));
    }
    catch {
        return false;
    }
}
/** A failed download: `status` is the HTTP status, or 0 when the update server could not be reached at all. */
export class FetchError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
async function fetchText(url, timeoutMs = 15000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
        let r;
        try {
            r = await fetch(url, { signal: c.signal, cache: "no-store" });
        }
        catch {
            throw new FetchError(0, `Could not reach the update server (${new URL(url).host}) — check this PC's internet connection`);
        }
        if (!r.ok)
            throw new FetchError(r.status, `${r.status} for ${url}`);
        return await r.text();
    }
    finally {
        clearTimeout(t);
    }
}
/** Fetch control.json and verify its signature; throws if missing or not signed by the owner. */
export async function fetchControl() {
    const base = releasesBase();
    const [body, sig] = await Promise.all([fetchText(`${base}/control.json`), fetchText(`${base}/control.json.sig`)]);
    if (!verifySignature(body, sig.trim()))
        throw new Error("The update server's control file is not correctly signed — ignoring it.");
    return JSON.parse(body);
}
/** Verify a manifest's text against its signature and the expected version; throws when it is not the owner's. */
export function parseSignedManifest(text, sigB64, version) {
    if (!verifySignature(text, sigB64.trim()))
        throw new Error("The update package is not correctly signed — refusing it.");
    const m = JSON.parse(text);
    if (m.version !== version)
        throw new Error("The update package version does not match.");
    return m;
}
/** Fetch and verify a version's manifest (with its text and signature, so it can be handed on to pharmacy PCs). */
export async function fetchManifestSigned(version) {
    const base = `${releasesBase()}/${encodeURIComponent(version)}`;
    const [text, sig] = await Promise.all([fetchText(`${base}/manifest.json`), fetchText(`${base}/manifest.json.sig`)]);
    return { manifest: parseSignedManifest(text, sig, version), text, sig: sig.trim() };
}
/** Fetch and verify a version's manifest. */
export async function fetchManifest(version) { return (await fetchManifestSigned(version)).manifest; }
