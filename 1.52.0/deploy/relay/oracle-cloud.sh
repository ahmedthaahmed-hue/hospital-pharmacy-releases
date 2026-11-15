#!/usr/bin/env bash
# Make the owner's phone relay on Oracle Cloud's "Always Free" tier, in one go (release 1.48, docs/RELAY-SERVER.md).
# Paste this into Oracle's Cloud Shell (the >_ button at the top of the Oracle Cloud console), signed in to your own
# account:
#
#   curl -fsSL https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main/relay/oracle-cloud.sh | bash
#
# It makes, in your account's home region: a network that lets in only ssh, http and https; one "Always Free" machine
# (VM.Standard.E2.1.Micro, or an Ampere A1 with 1 CPU and 6 GB if no micro is free); and on it, the relay with https
# (setup-relay.sh). Then it prints the relay's address. Everything it makes is in the Always Free tier: it costs
# nothing. Run it again and it reuses what is already there.
set -euo pipefail

RELEASES_BASE="${HPS_RELEASES_BASE:-https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main}"
NAME=hps-relay
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
command -v oci >/dev/null || die "this is meant for Oracle's Cloud Shell (the >_ button in the Oracle Cloud console)."
command -v jq >/dev/null || die "jq is missing (Cloud Shell has it)."

C="${OCI_TENANCY:-}"
[ -n "$C" ] || C=$(sed -n 's/^tenancy *= *//p' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}" 2>/dev/null | head -1)
[ -n "$C" ] || die "could not tell which Oracle account this is. Open Cloud Shell from the Oracle Cloud console and run it there."
q() { oci "$@" --raw-output 2>/dev/null; }

say "Network"
VCN=$(q network vcn list -c "$C" --display-name "$NAME" --lifecycle-state AVAILABLE --query 'data[0].id' || true)
if [ -z "$VCN" ] || [ "$VCN" = "null" ]; then
  VCN=$(q network vcn create -c "$C" --display-name "$NAME" --cidr-blocks '["10.77.0.0/16"]' --dns-label hpsrelay --wait-for-state AVAILABLE --query data.id) || die "could not make the network (is this your home region?)."
fi
[ -n "$VCN" ] || die "could not make the network."
IGW=$(q network internet-gateway list -c "$C" --vcn-id "$VCN" --query 'data[0].id' || true)
if [ -z "$IGW" ] || [ "$IGW" = "null" ]; then
  IGW=$(q network internet-gateway create -c "$C" --vcn-id "$VCN" --is-enabled true --display-name "$NAME-gateway" --wait-for-state AVAILABLE --query data.id) || die "could not make the internet gateway."
fi
RT=$(q network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"') || die "could not read the network."
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
SL=$(q network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"') || die "could not read the network."
rule() { printf '{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":%s,"max":%s}}}' "$1" "$1"; }
oci network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules "[$(rule 22),$(rule 80),$(rule 443)]" \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' >/dev/null
SUB=$(q network subnet list -c "$C" --vcn-id "$VCN" --display-name "$NAME-subnet" --query 'data[0].id' || true)
if [ -z "$SUB" ] || [ "$SUB" = "null" ]; then
  SUB=$(q network subnet create -c "$C" --vcn-id "$VCN" --cidr-block 10.77.1.0/24 --display-name "$NAME-subnet" --dns-label relay --wait-for-state AVAILABLE --query data.id) || die "could not make the subnet."
fi
[ -n "$SUB" ] || die "could not make the subnet."

say "The machine"
ID=$(q compute instance list -c "$C" --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id' || true)
if [ -z "$ID" ] || [ "$ID" = "null" ]; then
  [ -f "$HOME/.ssh/id_rsa.pub" ] || ssh-keygen -q -t rsa -b 3072 -N "" -f "$HOME/.ssh/id_rsa"
  cat > /tmp/hps-relay-init.sh <<EOF
#!/bin/bash
curl -fsSL --retry 5 "$RELEASES_BASE/relay/setup-relay.sh" -o /root/setup-relay.sh
HPS_RELEASES_BASE="$RELEASES_BASE" bash /root/setup-relay.sh --yes > /var/log/hps-relay-setup.log 2>&1
EOF
  mapfile -t ADS < <(oci iam availability-domain list -c "$C" | jq -r '.data[].name')
  for shape in VM.Standard.E2.1.Micro VM.Standard.A1.Flex; do
    for os in 24.04 22.04; do
      IMG=$(q compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "$os" --shape "$shape" --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' || true)
      [ -n "$IMG" ] && [ "$IMG" != "null" ] && break
    done
    [ -n "$IMG" ] && [ "$IMG" != "null" ] || continue
    extra=(); [ "$shape" = VM.Standard.A1.Flex ] && extra=(--shape-config '{"ocpus":1,"memoryInGBs":6}')
    for AD in "${ADS[@]}"; do
      echo "Trying $shape in $AD…"
      if out=$(oci compute instance launch -c "$C" --availability-domain "$AD" --shape "$shape" "${extra[@]}" \
          --image-id "$IMG" --subnet-id "$SUB" --assign-public-ip true --display-name "$NAME" \
          --user-data-file /tmp/hps-relay-init.sh --ssh-authorized-keys-file "$HOME/.ssh/id_rsa.pub" \
          --wait-for-state RUNNING --query data.id --raw-output 2>&1); then
        ID=$(printf '%s\n' "$out" | grep -o 'ocid1\.instance[^" ]*' | head -1)
        break 2
      else
        printf '%s\n' "$out" | grep -qiE "capacity|LimitExceeded|limit" && { echo "  none free there"; continue; }
        printf '%s\n' "$out" >&2
        die "Oracle refused to make the machine (above)."
      fi
    done
  done
fi
[ -n "$ID" ] && [ "$ID" != "null" ] || die "no Always Free machine is available in your region right now. Try again in a few hours."

IP=$(q compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"')
[ -n "$IP" ] && [ "$IP" != "null" ] || die "the machine has no public address."
URL="https://${IP//./-}.sslip.io"
say "Setting up the relay on $IP (a few minutes)"
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "$URL/health" >/dev/null 2>&1; then
    printf '\n  Done. The phone relay is ready:\n\n      %s\n\n  Send this address to the system'"'"'s owner.\n\n' "$URL"
    exit 0
  fi
  printf '.'; sleep 10
done
die "the machine is running but $URL does not answer yet. Wait a few minutes and open $URL/health in a browser;
it says {\"ok\":true} when ready. To look at the machine: ssh ubuntu@$IP, then: sudo cat /var/log/hps-relay-setup.log"
