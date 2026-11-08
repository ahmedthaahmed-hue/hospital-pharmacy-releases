#!/usr/bin/env bash
# Set up the owner's phone relay on a small Linux server (release 1.48, docs/RELAY-SERVER.md): an Oracle Cloud
# "Always Free" machine (oracle-cloud.sh runs this for you), or any Ubuntu, Debian or Oracle Linux machine with a
# public address. Free throughout: Node from nodejs.org, Caddy for https (a free Let's Encrypt certificate it renews by
# itself), and a free name: <your-address>.sslip.io, which needs no account (or your own with --domain).
#
#   curl -fsSL https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main/relay/setup-relay.sh | sudo bash
#   sudo bash setup-relay.sh --domain relay.example.org     (a name you own, pointing at this machine)
#
# The relay keeps no hospital data: it passes sealed envelopes it cannot read (docs/PHONE.md). It runs as its own
# account with no rights beyond its folder, listens only inside the machine, and Caddy alone faces the internet.
set -euo pipefail

RELEASES_BASE="${HPS_RELEASES_BASE:-https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main}"
CADDY_VERSION=2.10.2
# sha512 of caddy_<version>_linux_<arch>.tar.gz, from the release's checksums file
CADDY_SHA512_amd64=747df7ee74de188485157a383633a1a963fd9233b71fbb4a69ddcbcc589ce4e2cc82dacf5dbbe136cb51d17e14c59daeb5d9bc92487610b0f3b93680b2646546
CADDY_SHA512_arm64=6ce061a690312ab38367df3c5d5f89a2e4a263e7300d300d87356211bb81e79b15933e6d6203e03fbf26f15cc0311f264805f336147dbdd24938d84b57a4421c

domain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --yes) shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run it as root: sudo bash setup-relay.sh" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

say "Getting the tools it needs"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils tar >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q curl ca-certificates xz tar >/dev/null
fi

if [ -z "$domain" ]; then
  ip=$(curl -fsS4 --retry 3 https://api.ipify.org || curl -fsS4 --retry 3 https://ifconfig.me)
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not find this machine's public address; give one with --domain." >&2; exit 1; }
  domain="${ip//./-}.sslip.io"
fi
echo "The relay's address will be https://$domain"

say "Accounts and folders"
id hps-relay >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hps-relay --shell /usr/sbin/nologin hps-relay
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -m 700 -o hps-relay -g hps-relay /var/lib/hps-relay
install -d -m 700 -o caddy -g caddy /var/lib/caddy
install -d -m 755 /opt/hps-relay /etc/caddy

say "Node and the relay (signature checked)"
curl -fsSL --retry 3 "$RELEASES_BASE/relay/update-relay.sh" -o /opt/hps-relay/update-relay.sh
chmod 755 /opt/hps-relay/update-relay.sh
HPS_RELEASES_BASE="$RELEASES_BASE" bash /opt/hps-relay/update-relay.sh --force

say "Caddy $CADDY_VERSION (https)"
case "$(uname -m)" in x86_64) carch=amd64 ;; aarch64|arm64) carch=arm64 ;; *) echo "Unsupported processor" >&2; exit 1 ;; esac
if [ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_${carch}.tar.gz" -o "$tmp/caddy.tgz"
  want="CADDY_SHA512_$carch"
  echo "${!want}  $tmp/caddy.tgz" | sha512sum -c --quiet - || { echo "Caddy's download does not match its checksum: stopped." >&2; exit 1; }
  tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
  install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
cat > /etc/caddy/Caddyfile <<EOF
$domain {
	encode gzip
	header -Server
	reverse_proxy 127.0.0.1:8787
}
EOF

say "Services"
cat > /etc/systemd/system/hps-relay.service <<'EOF'
[Unit]
Description=Hospital Pharmacy phone relay
After=network-online.target
Wants=network-online.target

[Service]
User=hps-relay
Group=hps-relay
Environment=HPS_RELAY_DIR=/var/lib/hps-relay
Environment=HPS_RELAY_PORT=8787
ExecStart=/opt/hps-node/bin/node /opt/hps-relay/relay.mjs
Restart=always
RestartSec=3
MemoryMax=400M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/var/lib/hps-relay
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/hps-caddy.service <<'EOF'
[Unit]
Description=Caddy (https for the phone relay)
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/caddy

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/hps-relay-update.service <<'EOF'
[Unit]
Description=Update the Hospital Pharmacy phone relay (signed releases only)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/hps-relay/update-relay.sh
EOF
cat > /etc/systemd/system/hps-relay-update.timer <<'EOF'
[Unit]
Description=Check for a new phone relay every day

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now hps-relay hps-caddy hps-relay-update.timer >/dev/null
systemctl restart hps-relay hps-caddy

say "Opening ports 80 and 443"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload
fi
# Oracle's Ubuntu images refuse everything but ssh in iptables, and keep the rules in /etc/iptables/rules.v4
if command -v iptables >/dev/null; then
  for port in 80 443; do
    iptables -C INPUT -p tcp -m state --state NEW --dport $port -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport $port -j ACCEPT
  done
  if [ -f /etc/iptables/rules.v4 ]; then iptables-save > /etc/iptables/rules.v4; fi
fi

say "Waiting for the https certificate"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$domain/health" >/dev/null 2>&1; then
    echo
    echo "  The phone relay is ready:  https://$domain"
    echo
    echo "  Send this address to the system's owner (or put it in the repository variable RELAY_URL)."
    echo "$domain" > /var/lib/hps-relay/address
    exit 0
  fi
  sleep 10
done
echo "The relay is running, but https://$domain does not answer yet. If this is a cloud machine, check that its"
echo "network allows ports 80 and 443 from the internet, then run: sudo systemctl restart hps-caddy"
exit 1
