#!/usr/bin/env bash
set -euo pipefail

readonly SING_BOX_IMAGE='ghcr.io/sagernet/sing-box@sha256:da0e2331395c9025a85fa58892772b4cdbe5f2e530e93defeec3968175d06c6d'
lab_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$lab_dir/../.." && pwd)
runtime_root=${VPN_ROUTER_RUNTIME_ROOT:-$repo_dir}
lifecycle="$runtime_root/scripts/vpn-router-lifecycle.sh"
service_helper="$runtime_root/scripts/vpn-router-service.sh"
config_path="$lab_dir/config.yaml"
runtime_dir=$(mktemp -d /tmp/vpn-router-host-lab.XXXXXX)
strict_pid=''
direct_pid=''

[[ $(uname -s) == Linux ]] || { echo 'linux_interface_lab=SKIP_NON_LINUX'; exit 0; }
[[ $EUID -eq 0 ]] || { echo 'linux_interface_lab=FAIL: root privileges are required' >&2; exit 1; }

cleanup() {
  local status=$?
  "$lifecycle" disable --config "$config_path" >/dev/null 2>&1 || true
  systemctl stop vpr-host-lab-deadman.timer vpr-host-lab-deadman.service >/dev/null 2>&1 || true
  docker rm -f vpr-host-lab-socks >/dev/null 2>&1 || true
  [[ -z "$strict_pid" ]] || kill "$strict_pid" >/dev/null 2>&1 || true
  [[ -z "$direct_pid" ]] || kill "$direct_pid" >/dev/null 2>&1 || true
  ip netns del vpr-client >/dev/null 2>&1 || true
  ip link del vpr-in >/dev/null 2>&1 || true
  ip link del vpr-target >/dev/null 2>&1 || true
  rm -rf "$runtime_dir"
  return "$status"
}
trap cleanup EXIT INT TERM

for command_name in docker ip nft curl python3 systemd-run; do
  command -v "$command_name" >/dev/null || {
    echo "linux_interface_lab=FAIL: missing command: $command_name" >&2
    exit 1
  }
done

mkdir -p "$runtime_dir/strict" "$runtime_dir/direct"
printf 'strict-target\n' >"$runtime_dir/strict/index.html"
printf 'direct-target\n' >"$runtime_dir/direct/index.html"

ip netns add vpr-client
ip link add vpr-in type veth peer name eth0 netns vpr-client
ip address add 10.55.0.1/24 dev vpr-in
ip link set vpr-in up
ip netns exec vpr-client ip link set lo up
ip netns exec vpr-client ip address add 10.55.0.2/24 dev eth0
ip netns exec vpr-client ip link set eth0 up
ip netns exec vpr-client ip route add default via 10.55.0.1

ip link add vpr-target type dummy
ip address add 192.0.2.20/32 dev vpr-target
ip address add 192.0.2.30/32 dev vpr-target
ip link set vpr-target up

python3 -m http.server 18081 --bind 192.0.2.20 --directory "$runtime_dir/strict" >"$runtime_dir/strict.log" 2>&1 &
strict_pid=$!
python3 -m http.server 18081 --bind 192.0.2.30 --directory "$runtime_dir/direct" >"$runtime_dir/direct.log" 2>&1 &
direct_pid=$!

docker run -d --name vpr-host-lab-socks --network host \
  -v "$lab_dir/socks.json:/etc/sing-box/config.json:ro" \
  "$SING_BOX_IMAGE" -C /etc/sing-box run >/dev/null

fetch() {
  ip netns exec vpr-client curl --noproxy '*' -4fsS --connect-timeout 3 --max-time 5 "http://$1:18081/"
}

assert_response() {
  local target=$1 expected=$2 actual
  actual=$(fetch "$target")
  [[ "$actual" == "$expected" ]] || {
    echo "linux_interface_lab=FAIL: unexpected response from $target: $actual" >&2
    exit 1
  }
}

assert_blocked() {
  local target=$1
  if fetch "$target" >/dev/null 2>&1; then
    echo "linux_interface_lab=FAIL: strict target leaked directly: $target" >&2
    exit 1
  fi
}

network_snapshot() {
  local destination=$1
  {
    ip -j address show
    ip -j route show table all
    ip -j rule show
  } >"$destination"
}

wait_for_stable_host_network() {
  local _attempt previous="$runtime_dir/network-previous.json" current="$runtime_dir/network-current.json"
  network_snapshot "$previous"
  for _attempt in {1..15}; do
    sleep 1
    network_snapshot "$current"
    if cmp -s "$previous" "$current"; then return 0; fi
    mv "$current" "$previous"
  done
  echo 'linux_interface_lab=FAIL: host networking did not stabilize before baseline capture' >&2
  return 1
}

for _attempt in {1..20}; do
  if curl -4fsS --socks5-hostname 127.0.0.1:18080 --connect-timeout 2 --max-time 5 https://example.com/ >/dev/null 2>&1; then break; fi
  sleep 1
done

wait_for_stable_host_network

"$lifecycle" preflight --config "$config_path"
"$lifecycle" enable --config "$config_path" --rollback-after 120
assert_response 192.0.2.20 strict-target
assert_response 192.0.2.30 direct-target

docker stop vpr-host-lab-socks >/dev/null
assert_blocked 192.0.2.20
assert_response 192.0.2.30 direct-target
docker start vpr-host-lab-socks >/dev/null
sleep 2
assert_response 192.0.2.20 strict-target

docker stop vpr-host-lab >/dev/null
assert_blocked 192.0.2.20
assert_response 192.0.2.30 direct-target
docker start vpr-host-lab >/dev/null
sleep 2
"$lifecycle" verify --config "$config_path" --cancel-deadman

"$lifecycle" disable --config "$config_path"
assert_response 192.0.2.20 strict-target
assert_response 192.0.2.30 direct-target

wait_for_stable_host_network
VPN_ROUTER_CONFIG="$config_path" VPN_ROUTER_BOOT_WAIT_SECONDS=30 VPN_ROUTER_BOOT_ROLLBACK_AFTER=120 \
  "$service_helper" start
assert_response 192.0.2.20 strict-target
VPN_ROUTER_CONFIG="$config_path" "$service_helper" stop
assert_response 192.0.2.20 strict-target

echo 'linux_interface_lab=PASS'
