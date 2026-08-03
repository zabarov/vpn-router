#!/usr/bin/env bash
set -euo pipefail

readonly AWG2_IMAGE='amneziavpn/amneziawg-go:3.0.3@sha256:6ef2c3a07a07a40515ae97e2a204b93e12260d65bfb81866a0820e523a95f727'

input_path=''
native_config_path=''

usage() {
  echo 'Usage: run-isolated-amneziawg2-client.sh (--input <profile.vpn> | --native-config <profile.conf>)' >&2
}

while (($# > 0)); do
  case "$1" in
    --input)
      (($# >= 2)) || { usage; exit 2; }
      input_path=$2
      shift 2
      ;;
    --native-config)
      (($# >= 2)) || { usage; exit 2; }
      native_config_path=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -n "$input_path" && -n "$native_config_path" ]]; then
  usage
  exit 2
fi
if [[ -z "$input_path" && -z "$native_config_path" ]]; then
  usage
  exit 2
fi
if [[ -n "$input_path" && ! -f "$input_path" ]] || [[ -n "$native_config_path" && ! -f "$native_config_path" ]]; then
  usage
  exit 2
fi
if [[ $(uname -s) != Linux ]]; then
  echo 'native_awg2_test=FAIL: this command requires a Linux host' >&2
  exit 1
fi
if [[ ! -c /dev/net/tun ]]; then
  echo 'native_awg2_test=FAIL: /dev/net/tun is unavailable' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo 'native_awg2_test=FAIL: Docker Engine is unavailable' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
secret_dir=$(mktemp -d /tmp/vpn-router-awg2.XXXXXX)
chmod 700 "$secret_dir"
config_path="$secret_dir/awg0.conf"
runtime_config_path="$secret_dir/awg0-runtime.conf"
container_name="vpn-router-awg2-test-$$"
container_created=false

route_fingerprint() {
  {
    ip -j route show default
    ip -j rule show
    if [[ -n ${SSH_CONNECTION:-} ]]; then
      ip -j route get "${SSH_CONNECTION%% *}"
    fi
  } | sha256sum | awk '{print $1}'
}

cleanup() {
  if [[ "$container_created" == true ]]; then
    docker stop --time 3 "$container_name" >/dev/null 2>&1 || true
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
  if [[ -f "$config_path" && "$config_path" == /tmp/vpn-router-awg2.*/awg0.conf ]]; then
    unlink "$config_path"
  fi
  if [[ -f "$runtime_config_path" && "$runtime_config_path" == /tmp/vpn-router-awg2.*/awg0-runtime.conf ]]; then
    unlink "$runtime_config_path"
  fi
  if [[ -d "$secret_dir" && "$secret_dir" == /tmp/vpn-router-awg2.* ]]; then
    rmdir "$secret_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "$input_path" ]]; then
  command -v node >/dev/null 2>&1 || {
    echo 'native_awg2_test=FAIL: Node.js is required to decode a vpn:// profile' >&2
    exit 1
  }
  node "$script_dir/extract-amneziawg2-profile.mjs" --input "$input_path" --output "$config_path"
else
  install -m 600 -- "$native_config_path" "$config_path"
  echo 'profile_copy=PASS'
fi
chmod 600 "$config_path"

if grep -Eiq '^[[:space:]]*(PreUp|PostUp|PreDown|PostDown|SaveConfig)[[:space:]]*=' "$config_path"; then
  echo 'native_awg2_test=FAIL: command and persistence directives are forbidden in an isolated test profile' >&2
  exit 1
fi

# awg-quick's automatic full-tunnel policy writes a namespace sysctl and
# ip6tables kill-switch rules that Docker intentionally blocks without
# --privileged. Keep interface creation and AWG2 configuration in awg-quick,
# but make routing explicit inside this disposable namespace.
awk '
  /^\[Interface\][[:space:]]*$/ { in_interface=1; print; print "Table = off"; next }
  in_interface && /^\[/ { in_interface=0 }
  in_interface && /^[[:space:]]*(Table|DNS)[[:space:]]*=/ { next }
  { print }
' "$config_path" >"$runtime_config_path"
chmod 600 "$runtime_config_path"
route_before=$(route_fingerprint)

container_created=true
docker run -d \
  --name "$container_name" \
  --label org.opencontainers.image.title=vpn-router-awg2-test \
  --cap-drop ALL \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  --device /dev/net/tun:/dev/net/tun \
  --security-opt no-new-privileges=true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  -v "$runtime_config_path:/etc/amnezia/awg0.conf:ro" \
  "$AWG2_IMAGE" \
  sh -ec '
    apk add --no-cache ca-certificates curl openresolv >/dev/null
    gateway=$(ip -4 route show default | awk "NR == 1 { print \$3 }")
    uplink=$(ip -4 route show default | awk "NR == 1 { print \$5 }")
    awg-quick up /etc/amnezia/awg0.conf
    endpoint=$(awg show awg0 endpoints | awk "NR == 1 { print \$2 }")
    endpoint=${endpoint%:*}
    case "$endpoint" in
      *[!0-9.]*|"") echo "isolated route setup failed" >&2; exit 1 ;;
    esac
    ip -4 route replace "$endpoint/32" via "$gateway" dev "$uplink"
    ip -4 route replace default dev awg0
    printf "%s\n" "nameserver 1.1.1.1" "options timeout:2 attempts:2" >/etc/resolv.conf
    exec sleep infinity
  ' \
  >/dev/null

handshake_ok=false
for _attempt in {1..15}; do
  if [[ $(docker inspect --format '{{.State.Running}}' "$container_name") != true ]]; then
    echo 'native_awg2_test=FAIL: the isolated client exited before validation' >&2
    exit 1
  fi
  if docker exec "$container_name" awg show awg0 latest-handshakes \
      | awk 'BEGIN { ok=0 } $2 > 0 { ok=1 } END { exit ok ? 0 : 1 }'; then
    handshake_ok=true
    break
  fi
  sleep 2
done
if [[ "$handshake_ok" != true ]]; then
  echo 'handshake=FAIL' >&2
  exit 1
fi
echo 'handshake=PASS'

if ! docker exec "$container_name" sh -ec \
    'curl -4kfsS --max-time 20 https://1.1.1.1/cdn-cgi/trace | grep -q "^ip="'; then
  echo 'https=FAIL' >&2
  exit 1
fi
echo 'https=PASS'

if ! docker exec "$container_name" sh -ec \
    'curl -4fsS --max-time 20 https://www.cloudflare.com/cdn-cgi/trace | grep -q "^ip="'; then
  echo 'dns=FAIL' >&2
  exit 1
fi
echo 'dns=PASS'

docker exec "$container_name" awg show awg0 transfer \
  | awk 'BEGIN { ok=0 } $2 + $3 > 0 { ok=1 } END { exit ok ? 0 : 1 }'
echo 'transfer=PASS'

route_during=$(route_fingerprint)
if [[ "$route_before" != "$route_during" ]]; then
  echo 'host_route=FAIL: host default, policy, or SSH route changed' >&2
  exit 1
fi
echo 'host_route=UNCHANGED'

cleanup
container_created=false
trap - EXIT INT TERM
route_after=$(route_fingerprint)
if [[ "$route_before" != "$route_after" ]]; then
  echo 'cleanup=FAIL: host routes differ after cleanup' >&2
  exit 1
fi

echo 'cleanup=PASS'
echo 'native_awg2_test=PASS'
