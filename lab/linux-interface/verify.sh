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
  docker rm -f vpr-proxy-source vpr-host-lab-socks >/dev/null 2>&1 || true
  docker network rm vpr-external-egress >/dev/null 2>&1 || true
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

docker network create --subnet 172.29.55.0/24 vpr-external-egress >/dev/null
docker run -d --name vpr-host-lab-socks --network vpr-external-egress --ip 172.29.55.2 \
  -v "$lab_dir/socks.json:/etc/sing-box/config.json:ro" \
  "$SING_BOX_IMAGE" -C /etc/sing-box run >/dev/null
start_proxy_source() {
  docker run -d --name vpr-proxy-source --network vpr-external-egress --ip 172.29.55.3 \
    --entrypoint /bin/sleep \
    amneziavpn/amneziawg-go@sha256:6ef2c3a07a07a40515ae97e2a204b93e12260d65bfb81866a0820e523a95f727 infinity >/dev/null
}
start_proxy_source

proxy_fetch() {
  nsenter --target "$(docker inspect -f '{{.State.Pid}}' vpr-proxy-source)" --net -- \
    curl --noproxy '*' -4fsS --connect-timeout 3 --max-time 5 "http://$1:18081/"
}

proxy_blocked() {
  ! proxy_fetch "$1" >/dev/null 2>&1
}

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

for _attempt in {1..20}; do
  if curl -4fsS --socks5-hostname 172.29.55.2:1080 --connect-timeout 2 --max-time 5 https://example.com/ >/dev/null 2>&1; then break; fi
  sleep 1
done

sleep 3

"$lifecycle" preflight --config "$config_path"
"$lifecycle" enable --config "$config_path" --rollback-after 120
assert_response 192.0.2.20 strict-target
assert_response 192.0.2.30 direct-target
[[ $(proxy_fetch 192.0.2.20) == strict-target ]]
[[ $(proxy_fetch 192.0.2.30) == direct-target ]]

docker stop vpr-host-lab-socks >/dev/null
assert_blocked 192.0.2.20
assert_response 192.0.2.30 direct-target
proxy_blocked 192.0.2.20
[[ $(proxy_fetch 192.0.2.30) == direct-target ]]
docker start vpr-host-lab-socks >/dev/null
sleep 2
assert_response 192.0.2.20 strict-target
[[ $(proxy_fetch 192.0.2.20) == strict-target ]]

docker stop vpr-host-lab-capture-host vpr-host-lab-capture-proxy-vpn >/dev/null
assert_blocked 192.0.2.20
assert_response 192.0.2.30 direct-target
proxy_blocked 192.0.2.20
[[ $(proxy_fetch 192.0.2.30) == direct-target ]]
docker start vpr-host-lab-capture-host vpr-host-lab-capture-proxy-vpn >/dev/null
sleep 2
"$lifecycle" verify --config "$config_path" --cancel-deadman

old_proxy_id=$(docker inspect -f '{{.Id}}' vpr-proxy-source)
docker rm -f vpr-proxy-source >/dev/null
start_proxy_source
[[ $(docker inspect -f '{{.Id}}' vpr-proxy-source) != "$old_proxy_id" ]]
if "$lifecycle" verify --config "$config_path" >/dev/null 2>&1; then
  echo 'multi_source_linux_lifecycle_lab=FAIL: source recreation was not detected' >&2
  exit 1
fi
"$lifecycle" reconcile --config "$config_path" --rollback-after 120
[[ $(proxy_fetch 192.0.2.20) == strict-target ]]
[[ $(proxy_fetch 192.0.2.30) == direct-target ]]
"$lifecycle" verify --config "$config_path" --cancel-deadman

"$lifecycle" disable --config "$config_path"
"$lifecycle" disable --config "$config_path"
assert_response 192.0.2.20 strict-target
assert_response 192.0.2.30 direct-target
[[ $(proxy_fetch 192.0.2.20) == strict-target ]]
[[ $(proxy_fetch 192.0.2.30) == direct-target ]]

network_snapshot "$runtime_dir/network-after-disable.json"
VPN_ROUTER_CONFIG="$config_path" VPN_ROUTER_BOOT_WAIT_SECONDS=30 VPN_ROUTER_BOOT_ROLLBACK_AFTER=120 \
  "$service_helper" start
assert_response 192.0.2.20 strict-target
VPN_ROUTER_CONFIG="$config_path" "$service_helper" stop
assert_response 192.0.2.20 strict-target

echo 'multi_source_linux_lifecycle_lab=PASS'
