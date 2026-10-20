// Whether this main server answers over TLS now (set at startup, platform/tls.ts), and the certificate it shows.
import { X509Certificate } from "node:crypto";
let current = null;
export function setTlsCert(cert) {
    if (!cert) {
        current = null;
        return;
    }
    const x = new X509Certificate(cert);
    current = { cert, fingerprint: x.fingerprint256, validTo: new Date(x.validTo).toISOString() };
}
export const tlsInfo = () => current;
