#!/usr/bin/env bash
# shellcheck disable=SC1090
set -euo pipefail

readonly SING_BOX_IMAGE='ghcr.io/sagernet/sing-box@sha256:da0e2331395c9025a85fa58892772b4cdbe5f2e530e93defeec3968175d06c6d'
readonly DNS_IMAGE='vpn-router-dns:0.4.0-pre-alpha'

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
node_bin=${VPN_ROUTER_NODE:-node}

command_name=${1-}
if [[ -n "$command_name" ]]; then shift; fi
config_path=''
rollback_after=''
cancel_deadman=false
deadman_call=false

usage() {
  cat >&2 <<'EOF'
Usage:
  vpn-router-lifecycle.sh preflight --config <router.yaml>
  vpn-router-lifecycle.sh enable --config <router.yaml> --rollback-after <60-3600>
  vpn-router-lifecycle.sh disable --config <router.yaml>
  vpn-router-lifecycle.sh apply --config <router.yaml> --rollback-after <60-3600>
  vpn-router-lifecycle.sh status --config <router.yaml>
  vpn-router-lifecycle.sh verify --config <router.yaml> [--cancel-deadman]
  vpn-router-lifecycle.sh rollback --config <router.yaml>
  vpn-router-lifecycle.sh reconcile --config <router.yaml> --rollback-after <60-3600>
EOF
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage; exit 2; }
      config_path=$2
      shift 2
      ;;
    --rollback-after)
      (($# >= 2)) || { usage; exit 2; }
      rollback_after=$2
      shift 2
      ;;
    --cancel-deadman) cancel_deadman=true; shift ;;
    --deadman-call) deadman_call=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

case "$command_name" in
  preflight|enable|disable|apply|status|verify|rollback|reconcile) ;;
  *) usage; exit 2 ;;
esac
if [[ "$command_name" != apply && "$command_name" != enable && "$command_name" != reconcile && -n "$rollback_after" ]] \
  || [[ "$command_name" != verify && "$cancel_deadman" == true ]] \
  || [[ "$command_name" != rollback && "$deadman_call" == true ]]; then
  usage
  exit 2
fi
if [[ -z "$config_path" || ! -f "$config_path" ]]; then
  usage
  exit 2
fi
config_path=$(cd -- "$(dirname -- "$config_path")" && pwd)/$(basename -- "$config_path")

# Work from one private immutable snapshot so validation, rendering, manifest
# hashing, and the deadman cannot observe different revisions of the file.
invocation_config=$(mktemp /tmp/vpn-router-config.XXXXXX)
cleanup_invocation_config() {
  if [[ -f "$invocation_config" && "$invocation_config" == /tmp/vpn-router-config.* ]]; then
    unlink "$invocation_config"
  fi
}
trap cleanup_invocation_config EXIT
chmod 600 "$invocation_config"
cp -- "$config_path" "$invocation_config"
config_path=$invocation_config

"$node_bin" "$repo_dir/bin/vpn-router.mjs" validate --config "$config_path" >/dev/null
# render-runtime-env emits POSIX-quoted assignments and never emits a
# credential value; only the validated credential variable name is included.
eval "$("$node_bin" "$repo_dir/bin/vpn-router.mjs" render-runtime-env --config "$config_path")"

if [[ "$SOURCE_TYPE" == amneziawg2_container ]]; then
  compose_file="$repo_dir/deploy/compose.amneziawg2.yaml"
else
  compose_file="$repo_dir/deploy/compose.linux-interface.yaml"
fi
readonly compose_file
if [[ "$SOURCE_TYPE" == linux_interface && "$STRICT_EGRESS_TYPE" == tailscale_socks ]]; then
  echo 'lifecycle=FAIL: a host Linux source requires an external SOCKS5 or Linux-interface egress; managed Tailscale currently requires a container source' >&2
  exit 1
fi
if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks && "$TAILSCALE_PROXY_SERVER" != "${SERVICE_NAME}-egress" ]]; then
  echo "lifecycle=FAIL: proxy_server must equal ${SERVICE_NAME}-egress for the managed AmneziaWG2 adapter" >&2
  exit 1
fi

readonly STATE_ROOT="/var/lib/$SERVICE_NAME"
readonly RUNTIME_DIR="$STATE_ROOT/runtime"
readonly ARTIFACT_DIR="$RUNTIME_DIR/artifacts"
readonly MANIFEST="$RUNTIME_DIR/manifest.env"
readonly STORED_CONFIG="$RUNTIME_DIR/config.yaml"
readonly CAPTURE_NAME="$SERVICE_NAME"
readonly DNS_NAME="${SERVICE_NAME}-dns"
readonly EGRESS_NAME="${SERVICE_NAME}-egress"
readonly CONTROL_NETWORK="${SERVICE_NAME}-control"
readonly PROXY_NETWORK="${SERVICE_NAME}-proxy"
readonly EGRESS_STATE="$STATE_ROOT/egress-tailscale"
readonly DEADMAN_UNIT="${SERVICE_NAME}-deadman"

auth_key=${!TAILSCALE_AUTH_KEY_ENV-}

uses_managed_tailscale() {
  [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]]
}

uses_managed_dns() {
  [[ "$MANAGED_DNS_REQUIRED" == true ]]
}

uses_container_source() {
  [[ "$SOURCE_TYPE" == amneziawg2_container ]]
}

compose() {
  env \
    VPN_ROUTER_SOURCE_CONTAINER="$SOURCE_CONTAINER" \
    VPN_ROUTER_SERVICE_NAME="$CAPTURE_NAME" \
    VPN_ROUTER_DNS_SERVICE_NAME="$DNS_NAME" \
    VPN_ROUTER_EGRESS_SERVICE_NAME="$EGRESS_NAME" \
    VPN_ROUTER_EGRESS_STATE_DIRECTORY="$EGRESS_STATE" \
    VPN_ROUTER_CONTROL_NETWORK="$CONTROL_NETWORK" \
    VPN_ROUTER_PROXY_NETWORK="$PROXY_NETWORK" \
    VPN_ROUTER_TAILSCALE_AUTH_KEY="$auth_key" \
    VPN_ROUTER_TAILSCALE_EXIT_NODE="$TAILSCALE_EXIT_NODE" \
    VPN_ROUTER_TAILSCALE_PROXY_PORT="$TAILSCALE_PROXY_PORT" \
    VPN_ROUTER_SING_BOX_CONFIG="$ARTIFACT_DIR/sing-box.json" \
    VPN_ROUTER_DNSMASQ_CONFIG="$ARTIFACT_DIR/dnsmasq.conf" \
    docker compose --project-name "$SERVICE_NAME" -f "$compose_file" "$@"
}

source_exec() {
  if uses_container_source; then
    nsenter --target "$(source_pid)" --net -- "$@"
  else
    "$@"
  fi
}

source_pid() {
  docker inspect --format '{{.State.Pid}}' "$SOURCE_CONTAINER"
}

source_id() {
  if uses_container_source; then
    docker inspect --format '{{.Id}}' "$SOURCE_CONTAINER"
  else
    printf 'host:%s' "$(cat /proc/sys/kernel/random/boot_id)"
  fi
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

container_running() {
  [[ $(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true) == true ]]
}

egress_auth_key_scrubbed() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$EGRESS_NAME" 2>/dev/null \
    | grep -Fxq 'TS_AUTHKEY='
}

source_on_proxy_network() {
  uses_container_source || return 1
  docker network inspect "$PROXY_NETWORK" \
    --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null \
    | grep -Fxq "$SOURCE_CONTAINER"
}

owned_table_exists() {
  source_exec nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1
}

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

normalize_network_json() {
  local source=$1 destination=$2
  # JavaScript template syntax is intentionally passed verbatim to Node.
  # shellcheck disable=SC2016
  "$node_bin" -e '
    const fs = require("node:fs");
    const volatile = new Set(["expires", "preferred_life_time", "valid_life_time"]);
    const normalize = (value) => {
      if (Array.isArray(value)) {
        return value.map(normalize).sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)));
      }
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort()
          .filter((key) => !volatile.has(key))
          .map((key) => [key, normalize(value[key])]));
      }
      return value;
    };
    fs.writeFileSync(process.argv[2], `${JSON.stringify(normalize(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))))}\n`, { mode: 0o600 });
  ' "$source" "$destination"
}

manifest_matches_current_config() {
  [[ "${MANIFEST_VERSION-}" == 1 ]] || return 1
  [[ "${MANIFEST_SERVICE-}" == "$SERVICE_NAME" ]] || return 1
  [[ -f "$STORED_CONFIG" ]] || return 1
  [[ "${MANIFEST_CONFIG_SHA256-}" == "$(file_sha256 "$STORED_CONFIG")" ]] || return 1
  [[ "${MANIFEST_CONFIG_SHA256-}" == "$(file_sha256 "$config_path")" ]] || return 1
}

require_manifest_config_match() {
  source "$MANIFEST" || return 1
  if ! manifest_matches_current_config; then
    echo "lifecycle=FAIL: manifest does not match this config; use $STORED_CONFIG for status, verify, or rollback" >&2
    return 1
  fi
}

require_matching_active_manifest() {
  [[ -f "$MANIFEST" ]] || return 0
  source "$MANIFEST" || return 1
  case "${MANIFEST_STATUS-}" in
    applying|applied|rollback_failed)
      require_manifest_config_match || return 1
      ;;
    rolled_back|disabled) ;;
    *)
      echo 'lifecycle=FAIL: manifest has an unknown status' >&2
      return 1
      ;;
  esac
}

render_artifacts() {
  local destination=$1
  mkdir -p "$destination"
  chmod 700 "$destination"
  "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-sing-box --config "$config_path" >"$destination/sing-box.json"
  "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$config_path" >"$destination/vpn-router.nft"
  "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-dnsmasq --config "$config_path" >"$destination/dnsmasq.conf"
  chmod 600 "$destination"/*
}

validate_artifacts() {
  local destination=$1
  docker run --rm -v "$destination/sing-box.json:/config.json:ro" "$SING_BOX_IMAGE" check -c /config.json >/dev/null
  source_exec nft -c -f - <"$destination/vpn-router.nft"
}

require_base_runtime() {
  if [[ "$node_bin" == */* ]]; then
    [[ -x "$node_bin" ]]
  else
    command -v "$node_bin" >/dev/null
  fi
  command -v docker >/dev/null
  command -v nsenter >/dev/null
  command -v ip >/dev/null
  command -v nft >/dev/null
  command -v curl >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
  if uses_managed_tailscale; then
    docker network connect --help | grep -Fq -- '--gw-priority' || {
      echo 'preflight=FAIL: Docker Engine must support network gateway priorities' >&2
      return 1
    }
  fi
  if uses_container_source; then
    container_running "$SOURCE_CONTAINER" || {
      echo "preflight=FAIL: source container is not running" >&2
      return 1
    }
  fi
  source_exec ip -o link show dev "$SOURCE_INTERFACE" >/dev/null
  source_exec ip -o -4 addr show dev "$SOURCE_INTERFACE" | grep -q 'inet '
  if source_exec ip -o -6 addr show dev "$SOURCE_INTERFACE" scope global | grep -q 'inet6 '; then
    echo 'preflight=FAIL: global IPv6 is present on the source interface; the IPv4/TCP MVP refuses this topology' >&2
    return 1
  fi
}

require_unowned_or_managed_state() {
  if [[ -f "$MANIFEST" ]]; then
    source "$MANIFEST"
    if [[ "$MANIFEST_STATUS" == applying || "$MANIFEST_STATUS" == applied ]]; then
      require_matching_active_manifest
      return 0
    fi
  fi
  if owned_table_exists; then
    echo 'preflight=FAIL: the configured nftables table exists without an active project manifest' >&2
    return 1
  fi
  for name in "$CAPTURE_NAME" "$DNS_NAME" "$EGRESS_NAME"; do
    if container_exists "$name"; then
      echo "preflight=FAIL: container name is already in use: $name" >&2
      return 1
    fi
  done
  if uses_managed_tailscale; then
    for name in "$CONTROL_NETWORK" "$PROXY_NETWORK"; do
      if docker network inspect "$name" >/dev/null 2>&1; then
        echo "preflight=FAIL: Docker network name is already in use: $name" >&2
        return 1
      fi
    done
  fi
}

preflight_command() {
  require_base_runtime
  require_unowned_or_managed_state
  if uses_managed_tailscale; then
    if [[ -n "$auth_key" && ! "$auth_key" =~ ^tskey-auth-[A-Za-z0-9_-]{20,}$ ]]; then
      echo "preflight=FAIL: $TAILSCALE_AUTH_KEY_ENV is not a valid Tailscale auth key" >&2
      return 1
    fi
    if [[ -z "$auth_key" && ! -s "$EGRESS_STATE/tailscaled.state" ]]; then
      echo "preflight=FAIL: neither $TAILSCALE_AUTH_KEY_ENV nor enrolled Tailscale state is available" >&2
      return 1
    fi
  elif [[ "$STRICT_EGRESS_TYPE" == socks5 ]]; then
    source_exec curl -4fsS --globoff --connect-timeout 5 --max-time 10 \
      --socks5-hostname "$STRICT_EGRESS_SERVER:$STRICT_EGRESS_PORT" \
      "$STRICT_EGRESS_HEALTHCHECK_URL" >/dev/null || {
      echo 'preflight=FAIL: external SOCKS5 egress health check failed' >&2
      return 1
    }
  elif [[ "$STRICT_EGRESS_TYPE" == linux_interface ]]; then
    source_exec ip -o link show dev "$STRICT_EGRESS_INTERFACE" >/dev/null || {
      echo 'preflight=FAIL: strict egress interface is unavailable in the source namespace' >&2
      return 1
    }
    source_exec curl -4fsS --globoff --connect-timeout 5 --max-time 10 \
      --interface "$STRICT_EGRESS_INTERFACE" "$STRICT_EGRESS_HEALTHCHECK_URL" >/dev/null || {
      echo 'preflight=FAIL: strict egress interface health check failed' >&2
      return 1
    }
  fi
  command -v systemd-run >/dev/null || {
    echo 'preflight=FAIL: systemd-run is required for the rollback deadman' >&2
    return 1
  }

  local temp_dir
  temp_dir=$(mktemp -d /tmp/vpn-router-preflight.XXXXXX)
  trap 'rm -rf "$temp_dir"' RETURN
  render_artifacts "$temp_dir"
  validate_artifacts "$temp_dir"
  env \
    VPN_ROUTER_SOURCE_CONTAINER="$SOURCE_CONTAINER" \
    VPN_ROUTER_SERVICE_NAME="$CAPTURE_NAME" \
    VPN_ROUTER_DNS_SERVICE_NAME="$DNS_NAME" \
    VPN_ROUTER_EGRESS_SERVICE_NAME="$EGRESS_NAME" \
    VPN_ROUTER_EGRESS_STATE_DIRECTORY="$EGRESS_STATE" \
    VPN_ROUTER_CONTROL_NETWORK="$CONTROL_NETWORK" \
    VPN_ROUTER_PROXY_NETWORK="$PROXY_NETWORK" \
    VPN_ROUTER_TAILSCALE_EXIT_NODE="$TAILSCALE_EXIT_NODE" \
    VPN_ROUTER_TAILSCALE_PROXY_PORT="$TAILSCALE_PROXY_PORT" \
    VPN_ROUTER_SING_BOX_CONFIG="$temp_dir/sing-box.json" \
    VPN_ROUTER_DNSMASQ_CONFIG="$temp_dir/dnsmasq.conf" \
    docker compose --project-name "$SERVICE_NAME" -f "$compose_file" config --quiet
  rm -rf "$temp_dir"
  trap - RETURN
  echo 'preflight=PASS'
}

capture_backup() {
  local backup_dir timestamp ssh_peer
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$RUNTIME_DIR/backups"
  backup_dir=$(mktemp -d "$RUNTIME_DIR/backups/$timestamp.XXXXXX")
  chmod 700 "$backup_dir"
  if uses_container_source; then
    docker inspect "$SOURCE_CONTAINER" >"$backup_dir/source-container.json"
  else
    printf 'linux_interface\n' >"$backup_dir/source-kind.txt"
  fi
  docker ps -a --no-trunc >"$backup_dir/docker-containers.txt"
  docker network ls --no-trunc >"$backup_dir/docker-networks.txt"
  ip -j address show >"$backup_dir/host-addresses.json"
  ip -j route show table all >"$backup_dir/host-routes.json"
  ip -j rule show >"$backup_dir/host-rules.json"
  nft -j list ruleset >"$backup_dir/host-nftables.json"
  if [[ -n ${SSH_CONNECTION-} ]]; then
    ssh_peer=${SSH_CONNECTION%% *}
    printf '%s\n' "$ssh_peer" >"$backup_dir/host-ssh-peer.txt"
    ip -j route get "$ssh_peer" >"$backup_dir/host-ssh-route.json"
  fi
  source_exec ip -j address show >"$backup_dir/source-addresses.json"
  source_exec ip -j route show table all >"$backup_dir/source-routes.json"
  source_exec ip -j rule show >"$backup_dir/source-rules.json"
  source_exec nft -j list ruleset >"$backup_dir/source-nftables.json"
  sha256sum "$backup_dir"/* >"$backup_dir/SHA256SUMS"
  chmod 600 "$backup_dir"/*
  printf '%s' "$backup_dir"
}

verify_baseline_restored() {
  local timestamp verification_dir ssh_peer file matches=true
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$RUNTIME_DIR/rollback-verification"
  verification_dir=$(mktemp -d "$RUNTIME_DIR/rollback-verification/$timestamp.XXXXXX")
  chmod 700 "$verification_dir"

  ip -j address show >"$verification_dir/host-addresses.json" || matches=false
  ip -j route show table all >"$verification_dir/host-routes.json" || matches=false
  ip -j rule show >"$verification_dir/host-rules.json" || matches=false
  source_exec ip -j address show >"$verification_dir/source-addresses.json" || matches=false
  source_exec ip -j route show table all >"$verification_dir/source-routes.json" || matches=false
  source_exec ip -j rule show >"$verification_dir/source-rules.json" || matches=false

  if [[ -s "$MANIFEST_BACKUP_DIR/host-ssh-peer.txt" ]]; then
    ssh_peer=$(<"$MANIFEST_BACKUP_DIR/host-ssh-peer.txt")
    ip -j route get "$ssh_peer" >"$verification_dir/host-ssh-route.json" || matches=false
  fi

  for file in host-addresses.json host-routes.json source-addresses.json source-routes.json; do
    normalize_network_json "$MANIFEST_BACKUP_DIR/$file" "$verification_dir/baseline-$file" || matches=false
    normalize_network_json "$verification_dir/$file" "$verification_dir/stable-$file" || matches=false
    cmp -s "$verification_dir/baseline-$file" "$verification_dir/stable-$file" || matches=false
  done
  for file in host-rules.json source-rules.json; do
    cmp -s "$MANIFEST_BACKUP_DIR/$file" "$verification_dir/$file" || matches=false
  done
  if [[ -f "$MANIFEST_BACKUP_DIR/host-ssh-route.json" ]]; then
    normalize_network_json "$MANIFEST_BACKUP_DIR/host-ssh-route.json" "$verification_dir/baseline-host-ssh-route.json" || matches=false
    normalize_network_json "$verification_dir/host-ssh-route.json" "$verification_dir/stable-host-ssh-route.json" || matches=false
    cmp -s "$verification_dir/baseline-host-ssh-route.json" "$verification_dir/stable-host-ssh-route.json" || matches=false
  fi
  sha256sum "$verification_dir"/* >"$verification_dir/SHA256SUMS" || matches=false
  chmod 600 "$verification_dir"/* 2>/dev/null || matches=false
  [[ "$matches" == true ]]
}

write_manifest() {
  local status=$1 backup_dir=$2 connected=$3
  local current_source_id config_hash
  current_source_id=$(source_id 2>/dev/null || true)
  if [[ -z "$current_source_id" && -f "$MANIFEST" ]]; then
    source "$MANIFEST"
    current_source_id=$MANIFEST_SOURCE_ID
  fi
  config_hash=$(sha256sum "$STORED_CONFIG" | awk '{print $1}')
  umask 077
  {
    printf 'MANIFEST_VERSION=1\n'
    printf 'MANIFEST_STATUS=%s\n' "$status"
    printf 'MANIFEST_SERVICE=%s\n' "$SERVICE_NAME"
    printf 'MANIFEST_SOURCE_ID=%s\n' "$current_source_id"
    printf 'MANIFEST_CONFIG_SHA256=%s\n' "$config_hash"
    printf 'MANIFEST_BACKUP_DIR=%s\n' "$backup_dir"
    printf 'MANIFEST_PROXY_CONNECTED=%s\n' "$connected"
    printf 'MANIFEST_UPDATED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$MANIFEST"
  chmod 600 "$MANIFEST"
}

wait_for_tailscale() {
  local _attempt status_summary backend_state='unknown' exit_online='false'
  for _attempt in {1..45}; do
    status_summary=$(docker exec "$EGRESS_NAME" tailscale status --json 2>/dev/null \
      | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.BackendState||"unknown")+" "+(j.ExitNodeStatus?.Online===true?"true":"false"))}catch{process.stdout.write("unknown false")}})' \
      || true)
    read -r backend_state exit_online <<<"$status_summary"
    if [[ "$backend_state" == Running && "$exit_online" == true ]]; then
      if docker exec "$EGRESS_NAME" tailscale ping --timeout=5s --c 1 "$TAILSCALE_EXIT_NODE" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "apply=FAIL: Tailscale egress was not ready (state=$backend_state exit_online=$exit_online)" >&2
  return 1
}

wait_for_socks_egress() {
  local _attempt proxy_ip='' consecutive=0 healthy=false
  for _attempt in {1..45}; do
    healthy=false
    if uses_managed_tailscale; then
      proxy_ip=$(docker inspect --format "{{with index .NetworkSettings.Networks \"$PROXY_NETWORK\"}}{{.IPAddress}}{{end}}" "$EGRESS_NAME" 2>/dev/null || true)
      if [[ -n "$proxy_ip" ]] && source_exec curl -4fsS --globoff --connect-timeout 5 --max-time 10 \
        --socks5-hostname "$proxy_ip:$STRICT_EGRESS_PORT" "$STRICT_EGRESS_HEALTHCHECK_URL" >/dev/null 2>&1; then
        healthy=true
      fi
    elif [[ "$STRICT_EGRESS_TYPE" == socks5 ]]; then
      if source_exec curl -4fsS --globoff --connect-timeout 5 --max-time 10 \
        --socks5-hostname "$STRICT_EGRESS_SERVER:$STRICT_EGRESS_PORT" "$STRICT_EGRESS_HEALTHCHECK_URL" >/dev/null 2>&1; then
        healthy=true
      fi
    elif [[ "$STRICT_EGRESS_TYPE" == linux_interface ]]; then
      if source_exec curl -4fsS --globoff --connect-timeout 5 --max-time 10 \
        --interface "$STRICT_EGRESS_INTERFACE" "$STRICT_EGRESS_HEALTHCHECK_URL" >/dev/null 2>&1; then
        healthy=true
      fi
    else
      echo 'apply=FAIL: unsupported strict egress type reached runtime verification' >&2
      return 1
    fi
    if [[ "$healthy" == true ]]; then
      consecutive=$((consecutive + 1))
      if ((consecutive >= 3)); then return 0; fi
    else
      consecutive=0
    fi
    sleep 2
  done
  echo 'apply=FAIL: strict egress did not pass three consecutive HTTPS health checks' >&2
  return 1
}

capture_failure_evidence() {
  local failure_dir timestamp name
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$RUNTIME_DIR/failures"
  failure_dir=$(mktemp -d "$RUNTIME_DIR/failures/$timestamp.XXXXXX")
  chmod 700 "$failure_dir"
  for name in "$CAPTURE_NAME" "$DNS_NAME" "$EGRESS_NAME"; do
    if container_exists "$name"; then
      docker inspect --format \
        'name={{.Name}} id={{.Id}} image={{.Image}} running={{.State.Running}} status={{.State.Status}} exit={{.State.ExitCode}}' \
        "$name" >"$failure_dir/$name.status.txt" 2>&1 || true
      docker logs --tail 300 "$name" >"$failure_dir/$name.log" 2>&1 || true
    fi
  done
  chmod 600 "$failure_dir"/* 2>/dev/null || true
}

verify_internal() {
  [[ -f "$MANIFEST" ]] || return 1
  # The manifest contains only generated values and is root-only.
  source "$MANIFEST" || return 1
  [[ "$MANIFEST_STATUS" == applied ]] || return 1
  manifest_matches_current_config || return 1
  [[ "$MANIFEST_SOURCE_ID" == "$(source_id)" ]] || return 1
  owned_table_exists || return 1
  container_running "$CAPTURE_NAME" || return 1
  if uses_managed_dns; then container_running "$DNS_NAME" || return 1; fi
  if uses_managed_tailscale; then
    container_running "$EGRESS_NAME" || return 1
    egress_auth_key_scrubbed || return 1
    source_on_proxy_network || return 1
    docker exec "$EGRESS_NAME" tailscale status --json 2>/dev/null \
      | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.BackendState==="Running"&&j.ExitNodeStatus?.Online===true?0:1)}catch{process.exit(1)}})' \
      || return 1
  fi
  wait_for_socks_egress >/dev/null || return 1
}

cancel_deadman_timer() {
  systemctl stop "$DEADMAN_UNIT.timer" >/dev/null 2>&1 || true
  systemctl stop "$DEADMAN_UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$DEADMAN_UNIT.timer" "$DEADMAN_UNIT.service" >/dev/null 2>&1 || true
}

arm_deadman_timer() {
  local seconds=$1 script_path
  script_path=$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
  cancel_deadman_timer
  env -u "$TAILSCALE_AUTH_KEY_ENV" systemd-run \
    --quiet \
    --unit "$DEADMAN_UNIT" \
    --on-active "${seconds}s" \
    /bin/bash "$script_path" rollback --config "$STORED_CONFIG" --deadman-call
}

rollback_command() {
  if [[ ! -f "$MANIFEST" ]]; then
    if [[ "$deadman_call" != true ]]; then cancel_deadman_timer; fi
    echo 'rollback=ALREADY_ABSENT'
    return 0
  fi
  require_manifest_config_match || return 1
  local rollback_ok=true current_source_id name

  if [[ "$MANIFEST_STATUS" == rolled_back || "$MANIFEST_STATUS" == disabled ]]; then
    if ! owned_table_exists && ! source_on_proxy_network; then
      local runtime_absent=true
      for name in "$CAPTURE_NAME" "$DNS_NAME" "$EGRESS_NAME"; do
        container_exists "$name" && runtime_absent=false
      done
      if uses_managed_tailscale; then
        for name in "$CONTROL_NETWORK" "$PROXY_NETWORK"; do
          docker network inspect "$name" >/dev/null 2>&1 && runtime_absent=false
        done
      fi
      if [[ "$runtime_absent" == true ]]; then
        if [[ "$deadman_call" != true ]]; then cancel_deadman_timer; fi
        if [[ "$command_name" == disable ]]; then
          echo 'disable=ALREADY_DISABLED'
        else
          echo 'rollback=ALREADY_ROLLED_BACK'
        fi
        return 0
      fi
    fi
  fi

  if container_exists "$CAPTURE_NAME" || container_exists "$DNS_NAME"; then
    compose stop vpn-router vpn-router-dns >/dev/null 2>&1 || rollback_ok=false
    compose rm -f vpn-router vpn-router-dns >/dev/null 2>&1 || rollback_ok=false
  fi

  current_source_id=$(source_id 2>/dev/null || true)
  if [[ -n "$current_source_id" && "$current_source_id" == "$MANIFEST_SOURCE_ID" ]]; then
    if owned_table_exists; then source_exec nft delete table inet "$NFTABLES_TABLE" || rollback_ok=false; fi
    # The root-only manifest proves that this project created the network. Always
    # detach the managed source when it is still connected, including a failure
    # between docker network connect and the next manifest update.
    if source_on_proxy_network; then
      docker network disconnect "$PROXY_NETWORK" "$SOURCE_CONTAINER" || rollback_ok=false
    fi
  else
    echo 'rollback=FAIL: source container identity is unavailable or changed; refusing namespace cleanup' >&2
    rollback_ok=false
  fi

  compose down --remove-orphans >/dev/null 2>&1 || rollback_ok=false

  if [[ -n "$current_source_id" && "$current_source_id" == "$MANIFEST_SOURCE_ID" ]]; then
    owned_table_exists && rollback_ok=false
    source_on_proxy_network && rollback_ok=false
    verify_baseline_restored || rollback_ok=false
  fi
  for name in "$CAPTURE_NAME" "$DNS_NAME" "$EGRESS_NAME"; do
    container_exists "$name" && rollback_ok=false
  done
  if uses_managed_tailscale; then
    for name in "$CONTROL_NETWORK" "$PROXY_NETWORK"; do
      docker network inspect "$name" >/dev/null 2>&1 && rollback_ok=false
    done
  fi

  if [[ "$rollback_ok" != true ]]; then
    write_manifest rollback_failed "$MANIFEST_BACKUP_DIR" "$MANIFEST_PROXY_CONNECTED" || true
    echo 'rollback=FAIL: one or more owned resources remain; deadman is not cancelled' >&2
    return 1
  fi

  local final_status=rolled_back
  [[ "$command_name" == disable ]] && final_status=disabled
  write_manifest "$final_status" "$MANIFEST_BACKUP_DIR" false
  if [[ "$deadman_call" != true ]]; then cancel_deadman_timer; fi
  if [[ "$command_name" == disable ]]; then
    echo 'disable=PASS'
  elif [[ "$deadman_call" == true ]]; then
    echo 'rollback=PASS_DEADMAN'
  else
    echo 'rollback=PASS'
  fi
}

recover_recreated_source() {
  [[ -f "$MANIFEST" ]] || return 0
  source "$MANIFEST"
  local current_source_id recovery_dir timestamp name
  current_source_id=$(source_id 2>/dev/null || true)
  [[ -n "$current_source_id" ]] || {
    echo 'reconcile=FAIL: source container is unavailable' >&2
    return 1
  }
  [[ "$current_source_id" != "$MANIFEST_SOURCE_ID" ]] || return 0
  case "$MANIFEST_STATUS" in
    applying|applied|rollback_failed) ;;
    rolled_back|disabled) return 0 ;;
    *) echo 'reconcile=FAIL: manifest has an unknown status' >&2; return 1 ;;
  esac

  # A recreated source has a new network namespace, so the old owned nftables
  # table no longer exists. Refuse recovery if equivalent resources already
  # exist in the new namespace because their ownership would be ambiguous.
  if owned_table_exists || source_on_proxy_network; then
    echo 'reconcile=FAIL: the recreated source already contains project-named resources' >&2
    return 1
  fi

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  recovery_dir="$RUNTIME_DIR/recovery/$timestamp"
  mkdir -p "$recovery_dir"
  chmod 700 "$RUNTIME_DIR/recovery" "$recovery_dir"
  cp "$MANIFEST" "$recovery_dir/previous-manifest.env"
  cp "$STORED_CONFIG" "$recovery_dir/previous-config.yaml"
  printf '%s\n' "$current_source_id" >"$recovery_dir/replacement-source-id.txt"
  chmod 600 "$recovery_dir"/*

  cancel_deadman_timer
  compose down --remove-orphans >/dev/null 2>&1 || {
    echo 'reconcile=FAIL: stale owned containers or networks could not be removed' >&2
    return 1
  }
  for name in "$CAPTURE_NAME" "$DNS_NAME" "$EGRESS_NAME"; do
    if container_exists "$name"; then
      echo "reconcile=FAIL: stale owned container remains: $name" >&2
      return 1
    fi
  done
  if uses_managed_tailscale; then
    for name in "$CONTROL_NETWORK" "$PROXY_NETWORK"; do
      if docker network inspect "$name" >/dev/null 2>&1; then
        echo "reconcile=FAIL: stale owned network remains: $name" >&2
        return 1
      fi
    done
  fi
  rm -f "$MANIFEST" "$STORED_CONFIG"
  echo 'reconcile=SOURCE_RECREATION_RECOVERED'
}

apply_command() {
  if [[ ! "$rollback_after" =~ ^[0-9]+$ ]] || ((rollback_after < 60 || rollback_after > 3600)); then
    echo 'apply=FAIL: --rollback-after must be between 60 and 3600 seconds' >&2
    return 1
  fi
  [[ $EUID -eq 0 ]] || {
    echo 'apply=FAIL: root privileges are required' >&2
    return 1
  }
  require_matching_active_manifest || return 1
  if verify_internal 2>/dev/null; then
    arm_deadman_timer "$rollback_after"
    echo 'apply=ALREADY_APPLIED'
    echo "deadman=ARMED_${rollback_after}s"
    return 0
  fi
  if [[ -f "$MANIFEST" ]]; then
    source "$MANIFEST"
    if [[ "$MANIFEST_STATUS" == applying || "$MANIFEST_STATUS" == applied ]]; then
      rollback_command >/dev/null
    fi
  fi
  preflight_command >/dev/null

  umask 077
  mkdir -p "$ARTIFACT_DIR" "$EGRESS_STATE"
  chmod 700 "$STATE_ROOT" "$RUNTIME_DIR" "$ARTIFACT_DIR" "$EGRESS_STATE"
  cp "$config_path" "$STORED_CONFIG"
  chmod 600 "$STORED_CONFIG"
  render_artifacts "$ARTIFACT_DIR"
  validate_artifacts "$ARTIFACT_DIR"
  if uses_managed_dns; then
    docker build -t "$DNS_IMAGE" "$repo_dir/deploy/dnsmasq" >/dev/null
    docker run --rm -v "$ARTIFACT_DIR/dnsmasq.conf:/etc/dnsmasq.conf:ro" "$DNS_IMAGE" --test >/dev/null
  fi
  backup_dir=$(capture_backup)
  write_manifest applying "$backup_dir" false
  if ! arm_deadman_timer "$rollback_after"; then
    write_manifest rolled_back "$backup_dir" false
    echo 'apply=FAIL: could not arm the rollback deadman before mutation' >&2
    return 1
  fi

  apply_runtime() {
    local source_default_before source_default_after
    if uses_managed_tailscale; then
      compose up -d vpn-router-egress || return 1
      wait_for_tailscale || return 1
      if [[ -n "$auth_key" ]]; then
        auth_key=''
        unset "$TAILSCALE_AUTH_KEY_ENV"
        compose up -d --force-recreate vpn-router-egress || return 1
        wait_for_tailscale || return 1
        egress_auth_key_scrubbed || return 1
      fi
      source_default_before=$(source_exec ip -j route show default | sha256sum | awk '{print $1}') || return 1
      if ! source_on_proxy_network; then
        docker network connect --gw-priority -1 "$PROXY_NETWORK" "$SOURCE_CONTAINER" || return 1
        write_manifest applying "$backup_dir" true || return 1
      fi
      source_default_after=$(source_exec ip -j route show default | sha256sum | awk '{print $1}') || return 1
      [[ "$source_default_before" == "$source_default_after" ]] || return 1
      write_manifest applying "$backup_dir" true || return 1
    fi
    wait_for_socks_egress || return 1
    source_exec nft -f - <"$ARTIFACT_DIR/vpn-router.nft" || return 1
    if uses_managed_dns; then
      compose up -d vpn-router-dns vpn-router || return 1
    else
      compose up -d vpn-router || return 1
    fi
    container_running "$CAPTURE_NAME" || return 1
    if uses_managed_dns; then container_running "$DNS_NAME" || return 1; fi
    write_manifest applied "$backup_dir" "$(uses_managed_tailscale && echo true || echo false)" || return 1
    verify_internal || return 1
  }

  if ! apply_runtime; then
    echo 'apply=FAIL: applying the owned runtime failed; starting rollback' >&2
    capture_failure_evidence || true
    if ! rollback_command; then
      echo 'apply=FAIL: automatic rollback did not complete; the server-side deadman remains active' >&2
    fi
    return 1
  fi

  echo 'apply=PASS'
  echo "deadman=ARMED_${rollback_after}s"
}

reconcile_command() {
  [[ $EUID -eq 0 ]] || {
    echo 'reconcile=FAIL: root privileges are required' >&2
    return 1
  }
  recover_recreated_source
  apply_command
}

status_command() {
  if [[ ! -f "$MANIFEST" ]]; then
    echo 'status=NOT_APPLIED'
    return 0
  fi
  require_manifest_config_match || return 1
  local reported_status=$MANIFEST_STATUS drifted=false
  if [[ "$MANIFEST_STATUS" == applied ]] && ! verify_internal 2>/dev/null; then
    reported_status=drifted
    drifted=true
  fi
  echo "status=$reported_status"
  echo "client_scope_mode=$CLIENT_SCOPE_MODE"
  echo "client_scope_entries=$(awk -F, '{print NF}' <<<"$CLIENT_SCOPE_CIDRS")"
  echo "strict_egress_type=$STRICT_EGRESS_TYPE"
  if uses_container_source; then
    echo "source_container_running=$(container_running "$SOURCE_CONTAINER" && echo true || echo false)"
  else
    echo 'source_container_running=not_applicable'
  fi
  echo "capture_running=$(container_running "$CAPTURE_NAME" && echo true || echo false)"
  if uses_managed_dns; then
    echo "dns_running=$(container_running "$DNS_NAME" && echo true || echo false)"
  else
    echo 'dns_running=not_applicable'
  fi
  if uses_managed_tailscale; then
    echo "egress_running=$(container_running "$EGRESS_NAME" && echo true || echo false)"
  else
    echo 'egress_running=external'
  fi
  echo "nftables_table_present=$(owned_table_exists && echo true || echo false)"
  echo "source_proxy_connected=$(source_on_proxy_network && echo true || echo false)"
  [[ "$drifted" == false ]]
}

verify_command() {
  if [[ ! -f "$MANIFEST" ]]; then
    echo 'verify=FAIL: no project manifest exists' >&2
    return 1
  fi
  require_manifest_config_match || return 1
  if ! verify_internal; then
    echo 'verify=FAIL' >&2
    return 1
  fi
  if [[ "$cancel_deadman" == true ]]; then
    cancel_deadman_timer
    echo 'deadman=CANCELLED'
  fi
  echo 'verify=PASS'
}

case "$command_name" in
  preflight) preflight_command ;;
  enable|apply) apply_command ;;
  reconcile) reconcile_command ;;
  status) status_command ;;
  verify) verify_command ;;
  disable|rollback)
    [[ $EUID -eq 0 ]] || { echo 'rollback=FAIL: root privileges are required' >&2; exit 1; }
    rollback_command
    ;;
esac
