#!/usr/bin/env bash
# Install or update the phone relay on the owner's relay server (release 1.48, docs/RELAY-SERVER.md). Downloads
# relay.mjs from the public releases repo and installs it only if its signature checks out with the release public key
# the app trusts (the same key every PC checks updates with). Keeps Node (22, the long-term line) up to date too, from
# nodejs.org, checked against its published checksums. Run by setup-relay.sh, then every day by a systemd timer.
#
#   sudo bash update-relay.sh            install the published relay if it is newer (or not installed yet)
#   sudo bash update-relay.sh --force    install it again
set -euo pipefail

RELEASES_BASE="${HPS_RELEASES_BASE:-https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main}"
# server/src/platform/releases.ts RELEASE_PUBLIC_KEY_SPKI_B64 (a test keeps the two the same)
PUBLIC_KEY="MCowBQYDK2VwAyEAIbNP38wkYBwniivmxSHCsgIgen334969+63vlzB/elM="
NODE=/opt/hps-node/bin/node
APP=/opt/hps-relay

[ "$(id -u)" = 0 ] || { echo "Run it as root (sudo)." >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- Node ---
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;; esac
curl -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
line=$(grep -E " node-v22\.[0-9.]+-linux-$arch\.tar\.xz$" "$tmp/SHASUMS256.txt" | head -1)
tarball=${line##* }; nodever=${tarball#node-}; nodever=${nodever%-linux-*}
if [ "$("$NODE" --version 2>/dev/null || true)" != "$nodever" ]; then
  echo "Installing Node $nodever…"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v22.x/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && echo "$line" | sha256sum -c --quiet -) || { echo "Node's download does not match its checksum: stopped." >&2; exit 1; }
  rm -rf /opt/hps-node.new && mkdir -p /opt/hps-node.new
  tar -xJf "$tmp/$tarball" -C /opt/hps-node.new --strip-components=1
  rm -rf /opt/hps-node.old; [ -d /opt/hps-node ] && mv /opt/hps-node /opt/hps-node.old
  mv /opt/hps-node.new /opt/hps-node && rm -rf /opt/hps-node.old
  node_changed=1
fi

# --- the relay ---
curl -fsSL --retry 3 "$RELEASES_BASE/relay/version.txt" -o "$tmp/version.txt"
want=$(tr -d '[:space:]' < "$tmp/version.txt")
have=$(cat "$APP/version.txt" 2>/dev/null | tr -d '[:space:]' || true)
if [ "${1:-}" != "--force" ] && [ "$want" = "$have" ]; then
  echo "The relay is up to date ($have)."
  [ -n "${node_changed:-}" ] && systemctl restart hps-relay 2>/dev/null || true
  exit 0
fi

curl -fsSL --retry 3 "$RELEASES_BASE/relay/relay.mjs" -o "$tmp/relay.mjs"
curl -fsSL --retry 3 "$RELEASES_BASE/relay/relay.mjs.sig" -o "$tmp/relay.mjs.sig"
"$NODE" -e '
  const c = require("crypto"), fs = require("fs");
  const [file, sig, pub] = process.argv.slice(1);
  const key = c.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  const ok = c.verify(null, fs.readFileSync(file), key, Buffer.from(fs.readFileSync(sig, "utf8").trim(), "base64"));
  if (!ok) { console.error("The downloaded relay is NOT signed with the release key: refusing it."); process.exit(1); }
' "$tmp/relay.mjs" "$tmp/relay.mjs.sig" "$PUBLIC_KEY"

install -d -m 755 "$APP"
install -m 644 "$tmp/relay.mjs" "$APP/relay.mjs.new"
mv -f "$APP/relay.mjs.new" "$APP/relay.mjs"
echo "$want" > "$APP/version.txt"
systemctl restart hps-relay 2>/dev/null || true
echo "Installed relay $want (signature checked)."
