#!/usr/bin/env sh
set -eu

CDPATH=''
export CDPATH
lab_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$lab_dir/../.." && pwd)
compose_file="$lab_dir/compose.yaml"
project_name="vpn-router-redirect-lab"
artifact_dir=$(mktemp -d /tmp/vpn-router-redirect-lab.XXXXXX)
chmod 700 "$artifact_dir"
export VPN_ROUTER_LAB_NFTABLES_CONFIG="$artifact_dir/vpn-router.nft"
export VPN_ROUTER_LAB_SING_BOX_CONFIG="$artifact_dir/sing-box.json"
export VPN_ROUTER_LAB_DNSMASQ_CONFIG="$artifact_dir/dnsmasq.conf"

cleanup() {
  cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ]; then
    echo "Container lab diagnostics:" >&2
    docker compose -f "$compose_file" ps --all >&2 || true
    docker compose -f "$compose_file" logs --no-color >&2 || true
  fi
  docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  case "$artifact_dir" in
    /tmp/vpn-router-redirect-lab.*)
      if [ -d "$artifact_dir" ]; then rm -rf -- "$artifact_dir"; fi
      ;;
  esac
  return "$cleanup_status"
}
trap cleanup EXIT INT TERM

node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$lab_dir/config.yaml" >"$VPN_ROUTER_LAB_NFTABLES_CONFIG"
node "$repo_dir/bin/vpn-router.mjs" render-sing-box --config "$lab_dir/config.yaml" >"$VPN_ROUTER_LAB_SING_BOX_CONFIG"
node "$repo_dir/bin/vpn-router.mjs" render-dnsmasq --config "$lab_dir/config.yaml" >"$VPN_ROUTER_LAB_DNSMASQ_CONFIG"
# The 0700 parent limits host visibility. Read-only
# bind mounts need 0644 because the test containers deliberately drop DAC override.
chmod 644 "$artifact_dir"/*

fetch() {
  client=$1
  target=$2
  docker compose -f "$compose_file" exec -T source \
    ip netns exec "$client" wget -q -T 3 -O - "http://$target:18080/"
}

assert_response() {
  client=$1
  target=$2
  expected=$3
  actual=$(fetch "$client" "$target")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $client did not receive the expected response from $target" >&2
    exit 1
  fi
}

assert_blocked() {
  client=$1
  target=$2
  if actual=$(fetch "$client" "$target" 2>/dev/null); then
    echo "FAIL: strict request leaked after an egress-path failure (response: $actual)" >&2
    exit 1
  fi
}

resolve_strict() {
  docker compose -f "$compose_file" exec -T source \
    ip netns exec canary-client nslookup strict.test 192.0.2.53 \
    | grep -Fq '172.30.20.20'
}

docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$compose_file" up -d --wait
sidecar_id=$(docker compose -f "$compose_file" ps -q sidecar)

assert_response canary-client 172.30.20.30 direct-target
assert_response control-client 172.30.20.20 strict-target

docker compose -f "$compose_file" stop socks-egress >/dev/null
resolve_strict
docker compose -f "$compose_file" exec -T source \
  nft get element inet vpn_router_lab set_strict_target_dns '{ 172.30.20.20 }' \
  | grep -Fq 'expires'
assert_blocked canary-client 172.30.20.20
assert_response canary-client 172.30.20.30 direct-target
assert_response control-client 172.30.20.20 strict-target

docker compose -f "$compose_file" start socks-egress >/dev/null
sleep 2
assert_response canary-client 172.30.20.20 strict-target
if [ "$(docker compose -f "$compose_file" ps -q sidecar)" != "$sidecar_id" ]; then
  echo "FAIL: strict recovery restarted the redirect sidecar instead of re-resolving the SOCKS service" >&2
  exit 1
fi

docker compose -f "$compose_file" exec -T source \
  nft add element inet vpn_router_lab set_strict_target_dns '{ 198.51.100.42 timeout 2s }'
sleep 3
if docker compose -f "$compose_file" exec -T source \
  nft get element inet vpn_router_lab set_strict_target_dns '{ 198.51.100.42 }' >/dev/null 2>&1; then
  echo "FAIL: a dynamic DNS-set element outlived its explicit timeout" >&2
  exit 1
fi

docker compose -f "$compose_file" stop sidecar >/dev/null
assert_blocked canary-client 172.30.20.20
assert_response canary-client 172.30.20.30 direct-target
assert_response control-client 172.30.20.20 strict-target

cleanup
trap - EXIT INT TERM

if docker ps -a --filter "label=com.docker.compose.project=$project_name" --format '{{.ID}}' | grep -q .; then
  echo "FAIL: project containers remain after cleanup" >&2
  exit 1
fi
if docker network inspect "${project_name}_lab" >/dev/null 2>&1; then
  echo "FAIL: project network remains after cleanup" >&2
  exit 1
fi

echo "PASS: managed DNS selected the first connection, /32 strict traffic required TCP redirect and SOCKS, a stopped SOCKS name failed closed and recovered without restarting sing-box, both outages preserved direct traffic, dynamic entries expired, the second client was unaffected, and cleanup completed."
