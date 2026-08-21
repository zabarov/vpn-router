#!/usr/bin/env sh
set -eu

lab_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$lab_dir/../.." && pwd)
artifacts=$(mktemp -d /tmp/vpn-router-output-lab.XXXXXX)
export VPN_ROUTER_OUTPUT_NFT="$artifacts/router.nft"
export VPN_ROUTER_OUTPUT_SING_BOX="$artifacts/sing-box.json"
export VPN_ROUTER_OUTPUT_DNSMASQ="$artifacts/dnsmasq.conf"

cleanup() {
  status=$?
  [ "$status" -eq 0 ] || docker compose -f "$lab_dir/compose.yaml" logs --no-color >&2 || true
  docker compose -f "$lab_dir/compose.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  case "$artifacts" in /tmp/vpn-router-output-lab.*) rm -rf -- "$artifacts" ;; esac
  return "$status"
}
trap cleanup EXIT INT TERM

node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$lab_dir/config.yaml" --source proxy-source >"$VPN_ROUTER_OUTPUT_NFT"
node "$repo_dir/bin/vpn-router.mjs" render-sing-box --config "$lab_dir/config.yaml" --source proxy-source >"$VPN_ROUTER_OUTPUT_SING_BOX"
node "$repo_dir/bin/vpn-router.mjs" render-dnsmasq --config "$lab_dir/config.yaml" >"$VPN_ROUTER_OUTPUT_DNSMASQ"
chmod 644 "$artifacts"/*

compose="docker compose -f $lab_dir/compose.yaml"
$compose down --volumes --remove-orphans >/dev/null 2>&1 || true
$compose up -d --wait

fetch_source() { $compose exec -T source wget -q -T 3 -O - "http://$1:18080/"; }
fetch_control() { $compose exec -T control wget -q -T 3 -O - "http://$1:18080/"; }
blocked() { ! fetch_source "$1" >/dev/null 2>&1; }
wait_source() {
  target=$1 expected=$2 attempt=0
  while [ "$attempt" -lt 20 ]; do
    if [ "$(fetch_source "$target" 2>/dev/null || true)" = "$expected" ]; then return 0; fi
    attempt=$((attempt + 1)); sleep 1
  done
  return 1
}

[ "$(fetch_source 198.18.30.30)" = direct-target ]
[ "$(fetch_control 198.18.30.20)" = strict-target ]
if [ "$($compose exec -T source dig @127.0.0.1 strict.test A +short)" != 198.18.30.20 ]; then
  $compose exec -T source nft list table inet vpn_router_output >&2 || true
  $compose exec -T source netstat -lnup >&2 || true
  $compose logs --no-color dns upstream-dns >&2 || true
  exit 1
fi
$compose exec -T source nft get element inet vpn_router_output set_strict_target_dns '{ 198.18.30.20 }' >/dev/null
[ "$(fetch_source 198.18.30.20)" = strict-target ]

$compose stop socks-egress >/dev/null
blocked 198.18.30.20
[ "$(fetch_source 198.18.30.30)" = direct-target ]
$compose start socks-egress >/dev/null
wait_source 198.18.30.20 strict-target

$compose stop capture >/dev/null
blocked 198.18.30.20
[ "$(fetch_source 198.18.30.30)" = direct-target ]
[ "$(fetch_control 198.18.30.20)" = strict-target ]

cleanup
trap - EXIT INT TERM
echo 'output_capture_lab=PASS'
