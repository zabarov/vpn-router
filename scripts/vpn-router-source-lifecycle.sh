#!/usr/bin/env bash
set -euo pipefail

readonly SING_BOX_IMAGE='ghcr.io/sagernet/sing-box@sha256:da0e2331395c9025a85fa58892772b4cdbe5f2e530e93defeec3968175d06c6d'
readonly TAILSCALE_IMAGE='tailscale/tailscale:stable@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0'
readonly DNS_IMAGE='vpn-router-dns:0.6.0-alpha.1'

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
node_bin=${VPN_ROUTER_NODE:-node}

command_name=${1-}
[[ -n "$command_name" ]] && shift
config_path=''
rollback_after=''
cancel_deadman=false
deadman_call=false

usage() {
  cat >&2 <<'EOF'
Usage:
  vpn-router-source-lifecycle.sh preflight --config <router.yaml>
  vpn-router-source-lifecycle.sh enable --config <router.yaml> --rollback-after <60-3600>
  vpn-router-source-lifecycle.sh disable --config <router.yaml>
  vpn-router-source-lifecycle.sh status --config <router.yaml>
  vpn-router-source-lifecycle.sh verify --config <router.yaml> [--cancel-deadman]
  vpn-router-source-lifecycle.sh rollback --config <router.yaml>
  vpn-router-source-lifecycle.sh reconcile --config <router.yaml> --rollback-after <60-3600>
  vpn-router-source-lifecycle.sh recover --config <router.yaml>
EOF
}

while (($# > 0)); do
  case "$1" in
    --config) (($# >= 2)) || { usage; exit 2; }; config_path=$2; shift 2 ;;
    --rollback-after) (($# >= 2)) || { usage; exit 2; }; rollback_after=$2; shift 2 ;;
    --cancel-deadman) cancel_deadman=true; shift ;;
    --deadman-call) deadman_call=true; shift ;;
    *) usage; exit 2 ;;
  esac
done

case "$command_name" in preflight|enable|apply|disable|status|verify|rollback|reconcile|recover) ;; *) usage; exit 2 ;; esac
[[ -n "$config_path" && -f "$config_path" ]] || { usage; exit 2; }
if [[ "$command_name" =~ ^(enable|apply|reconcile)$ ]]; then
  [[ "$rollback_after" =~ ^[0-9]+$ && "$rollback_after" -ge 60 && "$rollback_after" -le 3600 ]] || {
    echo 'lifecycle=FAIL: enable and reconcile require --rollback-after between 60 and 3600 seconds' >&2
    exit 2
  }
elif [[ -n "$rollback_after" ]]; then
  usage; exit 2
fi

config_path=$(cd -- "$(dirname -- "$config_path")" && pwd)/$(basename -- "$config_path")
command -v flock >/dev/null 2>&1 || { echo 'lifecycle=FAIL: flock is required' >&2; exit 1; }
lock_key=$(printf '%s' "$config_path" | sha256sum | awk '{print substr($1,1,16)}')
exec 9>"/run/lock/vpn-router-$lock_key.lock"
case "$command_name" in
  status|verify|recover) flock -w 600 9 || { echo 'lifecycle=FAIL: timed out waiting for another lifecycle operation' >&2; exit 1; } ;;
  *) flock -n 9 || { echo 'lifecycle=FAIL: another lifecycle operation is already running' >&2; exit 1; } ;;
esac
"$node_bin" "$repo_dir/bin/vpn-router.mjs" validate --config "$config_path" >/dev/null
plan_tmp=$(mktemp /tmp/vpn-router-plan.XXXXXX)
trap 'rm -f "$plan_tmp"' EXIT
chmod 600 "$plan_tmp"
"$node_bin" "$repo_dir/bin/vpn-router.mjs" render-runtime-plan --config "$config_path" >"$plan_tmp"

json_value() {
  "$node_bin" -e '
    const fs=require("node:fs");
    let value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    for (const key of process.argv[2].split(".")) value=value?.[key];
    if (typeof value === "object") process.stdout.write(JSON.stringify(value));
    else if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$plan_tmp" "$1"
}

SERVICE_NAME=$(json_value service_name)
NFTABLES_TABLE=$(json_value nftables_table)
STRICT_EGRESS_TYPE=$(json_value strict_egress.type)
EGRESS_NAME=$(json_value egress_name)
CONTROL_NETWORK=$(json_value control_network)
PROXY_NETWORK=$(json_value proxy_network)
MANAGED_DNS=$(json_value managed_dns)
readonly SERVICE_NAME NFTABLES_TABLE STRICT_EGRESS_TYPE EGRESS_NAME CONTROL_NETWORK PROXY_NETWORK MANAGED_DNS
readonly STATE_ROOT="/var/lib/$SERVICE_NAME"
readonly RUNTIME_DIR="$STATE_ROOT/runtime"
readonly ARTIFACT_DIR="$RUNTIME_DIR/artifacts"
readonly MANIFEST="$RUNTIME_DIR/multi-source-manifest.env"
readonly STORED_CONFIG="$RUNTIME_DIR/multi-source-config.yaml"
readonly STORED_PLAN="$RUNTIME_DIR/multi-source-plan.json"
readonly EGRESS_STATE="$STATE_ROOT/egress-tailscale"
readonly DATA_STATE="$STATE_ROOT/data/state.json"
readonly EGRESS_PROXY_IP_FILE="$RUNTIME_DIR/tailscale-proxy-ip"
readonly DEADMAN_UNIT="${SERVICE_NAME}-deadman"

groups_tsv() {
  "$node_bin" -e '
    const fs=require("node:fs"), p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    for(const g of p.groups) console.log([g.tag,g.namespace,g.container_name??"none",g.source_tag,g.capture_name,g.dns_name].join("\t"));
  ' "$plan_tmp"
}

canonical_sources_tsv() {
  (cd "$repo_dir" && "$node_bin" --input-type=module -e '
    import fs from "node:fs"; import {parse} from "yaml"; import {normalizeConfig} from "./src/config-normalizer.mjs";
    const c=normalizeConfig(parse(fs.readFileSync(process.argv[1],"utf8")));
    for(const s of c.sources) console.log([s.tag,s.type,s.namespace??"container",s.container_name??"none",s.interface??"none"].join("\t"));
  ' "$config_path")
}

group_exec() {
  local namespace=$1 container=$2; shift 2
  if [[ "$namespace" == host ]]; then "$@"; else nsenter --target "$(docker inspect -f '{{.State.Pid}}' "$container")" --net -- "$@"; fi
}

container_running() { [[ $(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true) == true ]]; }
owned_container() { docker inspect -f '{{index .Config.Labels "io.github.rim.vpn-router.owner"}}' "$1" 2>/dev/null | grep -Fxq "$SERVICE_NAME"; }
network_exists() { docker network inspect "$1" >/dev/null 2>&1; }
namespace_identity() {
  local namespace=$1 container=$2 pid
  if [[ "$namespace" == host ]]; then readlink /proc/1/ns/net; return; fi
  pid=$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null || true)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  readlink "/proc/$pid/ns/net"
}
source_on_proxy_network() {
  [[ -n $(docker inspect -f "{{with index .NetworkSettings.Networks \"$PROXY_NETWORK\"}}{{.NetworkID}}{{end}}" "$1" 2>/dev/null || true) ]]
}
manifest_status() {
  [[ -f "$MANIFEST" ]] || return 1
  # shellcheck disable=SC1090
  source "$MANIFEST"
  printf '%s' "$MANIFEST_STATUS"
}

cancel_deadman() {
  systemctl stop "$DEADMAN_UNIT.timer" "$DEADMAN_UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$DEADMAN_UNIT.timer" "$DEADMAN_UNIT.service" >/dev/null 2>&1 || true
}

arm_deadman() {
  cancel_deadman
  systemd-run --quiet --unit "$DEADMAN_UNIT" --on-active "${1}s" \
    --setenv="VPN_ROUTER_NODE=$node_bin" \
    /bin/bash "$script_dir/vpn-router-source-lifecycle.sh" rollback --config "$STORED_CONFIG" --deadman-call
}

normalize_network_json() {
  "$node_bin" -e '
    const fs=require("node:fs"), volatile=new Set(["expires","ifindex","link_index","link_netnsid","preferred_life_time","valid_life_time"]);
    const ephemeral=v=>v&&typeof v==="object"&&!Array.isArray(v)&&[v.ifname,v.dev].some(n=>typeof n==="string"&&n.startsWith("veth"));
    const norm=v=>Array.isArray(v)?v.filter(x=>!ephemeral(x)).map(norm).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().filter(k=>!volatile.has(k)).map(k=>[k,norm(v[k])])):v;
    fs.writeFileSync(process.argv[2],JSON.stringify(norm(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))+"\n",{mode:0o600});
  ' "$1" "$2"
}

capture_baseline() {
  local stamp backup tag namespace container source_tag capture dns
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup=$(mktemp -d "$RUNTIME_DIR/backups/$stamp.XXXXXX")
  chmod 700 "$backup"
  ip -j address show >"$backup/host-addresses.json"
  ip -j route show table all >"$backup/host-routes.json"
  ip -j rule show >"$backup/host-rules.json"
  if [[ -n ${SSH_CONNECTION-} ]]; then ip -j route get "${SSH_CONNECTION%% *}" >"$backup/host-ssh-route.json"; fi
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    group_exec "$namespace" "$container" ip -j address show >"$backup/$tag-addresses.json"
    group_exec "$namespace" "$container" ip -j route show table all >"$backup/$tag-routes.json"
    group_exec "$namespace" "$container" ip -j rule show >"$backup/$tag-rules.json"
    if [[ "$namespace" == container ]]; then docker inspect "$container" >"$backup/$tag-container.json"; fi
  done < <(groups_tsv)
  sha256sum "$backup"/* >"$backup/SHA256SUMS"
  chmod 600 "$backup"/*
  printf '%s' "$backup"
}

verify_baseline() {
  local backup=$1 verify tag namespace container source_tag capture dns file left right ok=true
  verify=$(mktemp -d "$RUNTIME_DIR/rollback-verification/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  chmod 700 "$verify"
  ip -j address show >"$verify/host-addresses.json"
  ip -j route show table all >"$verify/host-routes.json"
  ip -j rule show >"$verify/host-rules.json"
  [[ ! -f "$backup/host-ssh-route.json" ]] || ip -j route get "$("$node_bin" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(j[0].dst)' "$backup/host-ssh-route.json")" >"$verify/host-ssh-route.json"
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    group_exec "$namespace" "$container" ip -j address show >"$verify/$tag-addresses.json" || ok=false
    group_exec "$namespace" "$container" ip -j route show table all >"$verify/$tag-routes.json" || ok=false
    group_exec "$namespace" "$container" ip -j rule show >"$verify/$tag-rules.json" || ok=false
  done < <(groups_tsv)
  for file in host-addresses.json host-routes.json host-rules.json host-ssh-route.json; do
    [[ -f "$backup/$file" ]] || continue
    if [[ "$file" == *rules* ]]; then cmp -s "$backup/$file" "$verify/$file" || ok=false
    else left="$verify/baseline-$file"; right="$verify/current-$file"; normalize_network_json "$backup/$file" "$left"; normalize_network_json "$verify/$file" "$right"; cmp -s "$left" "$right" || ok=false; fi
  done
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    for file in "$tag-addresses.json" "$tag-routes.json"; do left="$verify/baseline-$file"; right="$verify/current-$file"; normalize_network_json "$backup/$file" "$left"; normalize_network_json "$verify/$file" "$right"; cmp -s "$left" "$right" || ok=false; done
    cmp -s "$backup/$tag-rules.json" "$verify/$tag-rules.json" || ok=false
  done < <(groups_tsv)
  [[ "$ok" == true ]]
}

refresh_source_baseline() {
  local backup=$1 tag=$2 namespace=$3 container=$4 history file
  history=$(mktemp -d "$RUNTIME_DIR/recovery-evidence/$(date -u +%Y%m%dT%H%M%SZ)-$tag.XXXXXX")
  chmod 700 "$history"
  for file in "$tag-addresses.json" "$tag-routes.json" "$tag-rules.json" "$tag-container.json"; do
    [[ ! -f "$backup/$file" ]] || cp "$backup/$file" "$history/$file"
  done
  group_exec "$namespace" "$container" ip -j address show >"$backup/$tag-addresses.json"
  group_exec "$namespace" "$container" ip -j route show table all >"$backup/$tag-routes.json"
  group_exec "$namespace" "$container" ip -j rule show >"$backup/$tag-rules.json"
  docker inspect "$container" >"$backup/$tag-container.json"
  (
    cd "$backup"
    find . -maxdepth 1 -type f ! -name 'SHA256SUMS*' -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS.new
    mv SHA256SUMS.new SHA256SUMS
  )
  chmod 600 "$backup"/* "$history"/*
}

write_manifest() {
  local status=$1 backup=$2 config_hash plan_hash tag namespace container source_tag capture dns
  config_hash=$(sha256sum "$STORED_CONFIG" | awk '{print $1}')
  plan_hash=$(sha256sum "$STORED_PLAN" | awk '{print $1}')
  umask 077
  {
    printf 'MANIFEST_VERSION=2\nMANIFEST_STATUS=%q\n' "$status"
    printf 'MANIFEST_CONFIG_SHA256=%q\nMANIFEST_PLAN_SHA256=%q\n' "$config_hash" "$plan_hash"
    printf 'MANIFEST_BACKUP_DIR=%q\n' "$backup"
  } >"$MANIFEST"
  : >"$RUNTIME_DIR/source-ids.tsv"
  : >"$RUNTIME_DIR/source-namespaces.tsv"
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    if [[ "$namespace" == container ]]; then
      printf '%s=%s\n' "$tag" "$(docker inspect -f '{{.Id}}' "$container")" >>"$RUNTIME_DIR/source-ids.tsv"
      printf '%s=%s\n' "$tag" "$(namespace_identity "$namespace" "$container")" >>"$RUNTIME_DIR/source-namespaces.tsv"
    fi
  done < <(groups_tsv)
  chmod 600 "$MANIFEST" "$RUNTIME_DIR/source-ids.tsv" "$RUNTIME_DIR/source-namespaces.tsv"
}

require_manifest_match() {
  [[ -f "$MANIFEST" && -f "$STORED_CONFIG" && -f "$STORED_PLAN" ]] || return 1
  # shellcheck disable=SC1090
  source "$MANIFEST"
  [[ "$MANIFEST_VERSION" == 2 ]]
  [[ "$MANIFEST_CONFIG_SHA256" == "$(sha256sum "$STORED_CONFIG" | awk '{print $1}')" ]]
  [[ "$MANIFEST_CONFIG_SHA256" == "$(sha256sum "$config_path" | awk '{print $1}')" ]]
  [[ "$MANIFEST_PLAN_SHA256" == "$(sha256sum "$STORED_PLAN" | awk '{print $1}')" ]]
}

refresh_routing_data() {
  local destination=$1
  if [[ $(json_value config_schema_version) == 3.0 ]]; then
    "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" update --config "$config_path" --state "$destination" >/dev/null
  fi
}

verify_routing_data() {
  [[ $(json_value config_schema_version) != 3.0 ]] || \
    "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status --config "$config_path" --state "$DATA_STATE" >/dev/null
}

render_artifacts() {
  local data_state=${1-} tag namespace container source_tag capture dns dir
  local -a nft_args
  rm -rf "$ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR"
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    dir="$ARTIFACT_DIR/$tag"; mkdir -p "$dir"; chmod 700 "$dir"
    nft_args=(render-nftables --config "$config_path" --source "$source_tag")
    [[ -z "$data_state" ]] || nft_args+=(--routing-data "$data_state")
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" "${nft_args[@]}" >"$dir/router.nft"
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-sing-box --config "$config_path" --source "$source_tag" >"$dir/sing-box.json"
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-dnsmasq --config "$config_path" >"$dir/dnsmasq.conf"
    group_exec "$namespace" "$container" nft -c -f - <"$dir/router.nft"
    docker run --rm --network none -v "$dir/sing-box.json:/config.json:ro" "$SING_BOX_IMAGE" check -c /config.json >/dev/null
    chmod 600 "$dir"/*
  done < <(groups_tsv)
}

preflight() {
  [[ $EUID -eq 0 ]] || { echo 'preflight=FAIL: root privileges are required' >&2; return 1; }
  local command tag type namespace container interface source_tag capture dns managed_active=false
  for command in docker nsenter nft ip curl systemctl systemd-run sha256sum; do command -v "$command" >/dev/null; done
  docker info >/dev/null
  [[ $(json_value config_schema_version) =~ ^(2[.]0|3[.]0)$ ]] || { echo 'preflight=FAIL: multi-source lifecycle requires schema 2.0 or 3.0' >&2; return 1; }
  if require_manifest_match >/dev/null 2>&1; then
    # shellcheck disable=SC1090
    source "$MANIFEST"
    [[ "$MANIFEST_STATUS" =~ ^(applying|applied)$ ]] && managed_active=true
  fi
  while IFS=$'\t' read -r tag type namespace container interface; do
    if [[ "$namespace" == container ]]; then container_running "$container" || { echo "preflight=FAIL: source container is not running: $container" >&2; return 1; }; fi
    if [[ "$type" == tunnel_interface ]]; then
      group_exec "$namespace" "$container" ip -o -4 addr show dev "$interface" | grep -q 'inet '
      ! group_exec "$namespace" "$container" ip -o -6 addr show dev "$interface" scope global | grep -q 'inet6 ' || { echo "preflight=FAIL: global IPv6 is present on tunnel source $tag" >&2; return 1; }
    fi
  done < <(canonical_sources_tsv)
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    for name in "$capture" "$dns"; do
      if docker inspect "$name" >/dev/null 2>&1; then
        if [[ "$managed_active" != true ]] || ! owned_container "$name"; then
          echo "preflight=FAIL: container name is already occupied or drifted: $name" >&2
          return 1
        fi
      fi
    done
    if group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1; then
      [[ "$managed_active" == true ]] || { echo "preflight=FAIL: nftables table already exists in source namespace: $tag" >&2; return 1; }
    fi
  done < <(groups_tsv)
  for name in "$CONTROL_NETWORK" "$PROXY_NETWORK"; do
    if network_exists "$name"; then
      if [[ "$managed_active" != true ]] || [[ $(docker network inspect -f '{{index .Labels "io.github.rim.vpn-router.owner"}}' "$name") != "$SERVICE_NAME" ]]; then
        echo "preflight=FAIL: Docker network name is already owned by another runtime: $name" >&2
        return 1
      fi
    fi
  done
  if docker inspect "$EGRESS_NAME" >/dev/null 2>&1; then
    if [[ "$managed_active" != true ]] || ! owned_container "$EGRESS_NAME"; then
      echo "preflight=FAIL: egress container name is already occupied or drifted: $EGRESS_NAME" >&2
      return 1
    fi
  fi
  if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]]; then
    docker network connect --help | grep -Fq -- '--gw-priority'
    mkdir -p "$EGRESS_STATE"; chmod 700 "$EGRESS_STATE"
    local auth_env auth_value
    auth_env=$(json_value strict_egress.auth_key_env); auth_value=${!auth_env-}
    [[ -n "$auth_value" || -s "$EGRESS_STATE/tailscaled.state" ]] || { echo "preflight=FAIL: $auth_env is required for first enrollment" >&2; return 1; }
  fi
  mkdir -p "$RUNTIME_DIR" "$ARTIFACT_DIR"; chmod 700 "$STATE_ROOT" "$RUNTIME_DIR" "$ARTIFACT_DIR"
  docker image inspect "$DNS_IMAGE" >/dev/null 2>&1 || docker build -q -t "$DNS_IMAGE" "$repo_dir/deploy/dnsmasq" >/dev/null
  local preflight_data='' preflight_data_dir=''
  if [[ $(json_value config_schema_version) == 3.0 ]]; then
    preflight_data_dir=$(mktemp -d /tmp/vpn-router-data.XXXXXX)
    chmod 700 "$preflight_data_dir"
    preflight_data="$preflight_data_dir/state.json"
    if [[ -f "$DATA_STATE" ]]; then cp "$DATA_STATE" "$preflight_data"; chmod 600 "$preflight_data"; fi
    if ! refresh_routing_data "$preflight_data"; then rm -rf "$preflight_data_dir"; return 1; fi
  fi
  render_artifacts "$preflight_data"
  [[ -z "$preflight_data_dir" ]] || rm -rf "$preflight_data_dir"
  if [[ "$STRICT_EGRESS_TYPE" != tailscale_socks ]]; then
    while IFS=$'\t' read -r tag namespace container source_tag capture dns; do healthcheck_group "$namespace" "$container"; done < <(groups_tsv)
  fi
  echo 'preflight=PASS'
  echo "source_groups=$(groups_tsv | wc -l | tr -d ' ')"
}

wait_tailscale_ready() {
  local ready=false
  for _ in {1..60}; do
    if docker exec "$EGRESS_NAME" tailscale status --json 2>/dev/null | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.BackendState==="Running"&&j.ExitNodeStatus?.Online?0:1)}catch{process.exit(1)}})'; then ready=true; break; fi
    sleep 2
  done
  [[ "$ready" == true ]]
}

start_egress() {
  [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]] || return 0
  local exit_node proxy_port auth_env auth_value publish=()
  exit_node=$(json_value strict_egress.exit_node); proxy_port=$(json_value strict_egress.proxy_port)
  auth_env=$(json_value strict_egress.auth_key_env); auth_value=${!auth_env-}
  docker network create --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" "$CONTROL_NETWORK" >/dev/null
  docker network create --internal --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" "$PROXY_NETWORK" >/dev/null
  groups_tsv | awk -F '\t' '$2=="host"{found=1} END{exit !found}' && publish=(-p "127.0.0.1:$proxy_port:$proxy_port")
  docker run -d --name "$EGRESS_NAME" --hostname "$EGRESS_NAME" --restart unless-stopped \
    --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" --cap-drop ALL --security-opt no-new-privileges:true \
    --network "$CONTROL_NETWORK" "${publish[@]}" -v "$EGRESS_STATE:/var/lib/tailscale" \
    -e "TS_AUTHKEY=$auth_value" -e "TS_EXTRA_ARGS=--exit-node=$exit_node --exit-node-allow-lan-access=false --accept-routes=false --accept-dns=false" \
    -e TS_STATE_DIR=/var/lib/tailscale -e TS_USERSPACE=true -e "TS_SOCKS5_SERVER=0.0.0.0:$proxy_port" -e TS_AUTH_ONCE=true "$TAILSCALE_IMAGE" >/dev/null
  docker network connect --gw-priority -1 --alias "$EGRESS_NAME" "$PROXY_NETWORK" "$EGRESS_NAME"
  if ! wait_tailscale_ready; then
    echo 'enable=FAIL: managed Tailscale egress did not become ready before auth-key scrubbing' >&2
    return 1
  fi
  if [[ -n "$auth_value" ]]; then
    docker rm -f "$EGRESS_NAME" >/dev/null
    auth_value=''; unset "$auth_env" || true
    docker run -d --name "$EGRESS_NAME" --hostname "$EGRESS_NAME" --restart unless-stopped \
      --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" --cap-drop ALL --security-opt no-new-privileges:true \
      --network "$CONTROL_NETWORK" "${publish[@]}" -v "$EGRESS_STATE:/var/lib/tailscale" \
      -e TS_AUTHKEY= -e "TS_EXTRA_ARGS=--exit-node=$exit_node --exit-node-allow-lan-access=false --accept-routes=false --accept-dns=false" \
      -e TS_STATE_DIR=/var/lib/tailscale -e TS_USERSPACE=true -e "TS_SOCKS5_SERVER=0.0.0.0:$proxy_port" -e TS_AUTH_ONCE=true "$TAILSCALE_IMAGE" >/dev/null
    docker network connect --gw-priority -1 --alias "$EGRESS_NAME" "$PROXY_NETWORK" "$EGRESS_NAME"
    if ! wait_tailscale_ready; then
      echo 'enable=FAIL: managed Tailscale egress did not recover after auth-key scrubbing' >&2
      return 1
    fi
  fi
}

pin_tailscale_proxy_ip() {
  [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]] || return 0
  local proxy_ip tag namespace container source_tag capture dns config
  proxy_ip=$(docker inspect -f "{{with index .NetworkSettings.Networks \"$PROXY_NETWORK\"}}{{.IPAddress}}{{end}}" "$EGRESS_NAME")
  [[ "$proxy_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'enable=FAIL: managed egress has no IPv4 address on the proxy network' >&2; return 1; }
  printf '%s\n' "$proxy_ip" >"$EGRESS_PROXY_IP_FILE"; chmod 600 "$EGRESS_PROXY_IP_FILE"
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    [[ "$namespace" == container ]] || continue
    config="$ARTIFACT_DIR/$tag/sing-box.json"
    "$node_bin" -e '
      const fs=require("node:fs"), path=process.argv[1], server=process.argv[2];
      const config=JSON.parse(fs.readFileSync(path,"utf8"));
      const outbound=config.outbounds.find(item=>item.type==="socks");
      if(!outbound) process.exit(2);
      outbound.server=server;
      delete outbound.domain_resolver;
      fs.writeFileSync(path,JSON.stringify(config,null,2)+"\n",{mode:0o600});
    ' "$config" "$proxy_ip"
    docker run --rm --network none -v "$config:/config.json:ro" "$SING_BOX_IMAGE" check -c /config.json >/dev/null
  done < <(groups_tsv)
}

start_group() {
  local tag=$1 namespace=$2 container=$3 source_tag=$4 capture=$5 dns=$6 network_args
  local dir="$ARTIFACT_DIR/$tag"
  if [[ "$namespace" == host ]]; then network_args=(--network host); else network_args=(--network "container:$container"); fi
  group_exec "$namespace" "$container" nft -f - <"$dir/router.nft"
  if [[ "$MANAGED_DNS" == true ]]; then
    docker run -d --name "$dns" --restart unless-stopped --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" \
      "${network_args[@]}" --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
      -v "$dir/dnsmasq.conf:/etc/dnsmasq.conf:ro" "$DNS_IMAGE" >/dev/null
  fi
  docker run -d --name "$capture" --restart unless-stopped --label "io.github.rim.vpn-router.owner=$SERVICE_NAME" \
    "${network_args[@]}" --cap-drop ALL --cap-add NET_ADMIN --security-opt no-new-privileges:true \
    -v "$dir/sing-box.json:/etc/sing-box/config.json:ro" "$SING_BOX_IMAGE" -C /etc/sing-box run >/dev/null
}

attach_sources() {
  [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]] || return 0
  local tag namespace container source_tag capture dns
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    [[ "$namespace" == container ]] || continue
    docker network connect --gw-priority -1 "$PROXY_NETWORK" "$container"
  done < <(groups_tsv)
}

healthcheck_group_once() {
  local namespace=$1 container=$2 url server port interface
  url=$(json_value strict_egress.healthcheck_url)
  case "$STRICT_EGRESS_TYPE" in
    tailscale_socks) port=$(json_value strict_egress.proxy_port); [[ "$namespace" == host ]] && server=127.0.0.1 || server=$(cat "$EGRESS_PROXY_IP_FILE"); group_exec "$namespace" "$container" curl -4fsS --connect-timeout 5 --max-time 15 --socks5-hostname "$server:$port" "$url" >/dev/null ;;
    socks5) server=$(json_value strict_egress.server); port=$(json_value strict_egress.port); group_exec "$namespace" "$container" curl -4fsS --connect-timeout 5 --max-time 15 --socks5-hostname "$server:$port" "$url" >/dev/null ;;
    linux_interface) interface=$(json_value strict_egress.interface); group_exec "$namespace" "$container" curl -4fsS --connect-timeout 5 --max-time 15 --interface "$interface" "$url" >/dev/null ;;
  esac
}

healthcheck_group() {
  local namespace=$1 container=$2 consecutive=0
  for _attempt in {1..30}; do
    if healthcheck_group_once "$namespace" "$container"; then
      consecutive=$((consecutive + 1))
      ((consecutive >= 3)) && return 0
    else
      consecutive=0
    fi
    sleep 2
  done
  return 1
}

capture_failure_diagnostics() {
  local reason=$1 dir tag namespace container source_tag capture dns
  mkdir -p "$RUNTIME_DIR/failures"; chmod 700 "$RUNTIME_DIR/failures"
  dir=$(mktemp -d "$RUNTIME_DIR/failures/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  chmod 700 "$dir"
  printf '%s\n' "$reason" >"$dir/reason.txt"
  docker ps -a --no-trunc >"$dir/docker-ps.txt" 2>&1 || true
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    docker inspect "$capture" >"$dir/$tag-capture.inspect.json" 2>&1 || true
    docker logs "$capture" >"$dir/$tag-capture.log" 2>&1 || true
    docker inspect "$dns" >"$dir/$tag-dns.inspect.json" 2>&1 || true
    docker logs "$dns" >"$dir/$tag-dns.log" 2>&1 || true
    group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >"$dir/$tag-nftables.txt" 2>&1 || true
  done < <(groups_tsv)
  if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]]; then
    docker inspect "$EGRESS_NAME" >"$dir/egress.inspect.json" 2>&1 || true
    docker logs "$EGRESS_NAME" >"$dir/egress.log" 2>&1 || true
  fi
  chmod 600 "$dir"/*
  printf 'failure_evidence=%s\n' "$dir" >&2
}

verify_applied() {
  local tag namespace container source_tag capture dns stored_id current_id stored_namespace current_namespace
  require_manifest_match || { echo 'verify=FAIL: manifest or configuration mismatch' >&2; return 1; }
  # shellcheck disable=SC1090
  source "$MANIFEST"
  [[ "$MANIFEST_STATUS" == applied ]] || { echo "verify=FAIL: manifest status is $MANIFEST_STATUS" >&2; return 1; }
  verify_routing_data || { echo 'verify=FAIL: routing data is unavailable or stale' >&2; return 1; }
  [[ "$STRICT_EGRESS_TYPE" != tailscale_socks ]] || { container_running "$EGRESS_NAME" && owned_container "$EGRESS_NAME"; } || { echo 'verify=FAIL: managed egress is not running or not owned' >&2; return 1; }
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    if [[ "$namespace" == container ]]; then
      stored_id=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-ids.tsv")
      stored_namespace=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-namespaces.tsv" 2>/dev/null || true)
      current_id=$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null || true)
      current_namespace=$(namespace_identity "$namespace" "$container" 2>/dev/null || true)
      [[ -n "$stored_namespace" && "$stored_id" == "$current_id" && "$stored_namespace" == "$current_namespace" ]] \
        || { echo "verify=FAIL: source namespace identity changed for source group $tag" >&2; return 1; }
    fi
    if ! container_running "$capture" || ! owned_container "$capture"; then
      echo "verify=FAIL: capture is not running or not owned for source group $tag" >&2
      return 1
    fi
    [[ "$MANAGED_DNS" != true ]] || { container_running "$dns" && owned_container "$dns"; } || { echo "verify=FAIL: managed DNS is not running or not owned for source group $tag" >&2; return 1; }
    group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1 || { echo "verify=FAIL: nftables table is absent for source group $tag" >&2; return 1; }
    healthcheck_group "$namespace" "$container" || { echo "verify=FAIL: strict egress healthcheck failed for source group $tag" >&2; return 1; }
  done < <(groups_tsv)
}

owned_absent() {
  local tag namespace container source_tag capture dns
  ! docker inspect "$EGRESS_NAME" >/dev/null 2>&1 || return 1
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    ! docker inspect "$capture" >/dev/null 2>&1 || return 1
    ! docker inspect "$dns" >/dev/null 2>&1 || return 1
    ! group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1 || return 1
  done < <(groups_tsv)
  ! network_exists "$CONTROL_NETWORK" && ! network_exists "$PROXY_NETWORK"
}

rollback_runtime() {
  local allow_source_change=${1:-false} tag namespace container source_tag capture dns stored_id current_id backup ok=true
  [[ -f "$MANIFEST" ]] || {
    cancel_deadman
    if [[ "$command_name" == disable ]]; then
      systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
      systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
    fi
    echo 'rollback=ALREADY_ABSENT'
    return 0
  }
  require_manifest_match || { echo 'rollback=FAIL: manifest or config mismatch' >&2; return 1; }
  # shellcheck disable=SC1090
  source "$MANIFEST"; backup=$MANIFEST_BACKUP_DIR
  if [[ "$MANIFEST_STATUS" =~ ^(disabled|rolled_back)$ ]] && owned_absent; then cancel_deadman; [[ "$command_name" == disable ]] && echo 'disable=ALREADY_DISABLED' || echo 'rollback=ALREADY_ROLLED_BACK'; return 0; fi
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    if owned_container "$capture"; then docker rm -f "$capture" >/dev/null || true; fi
    if owned_container "$dns"; then docker rm -f "$dns" >/dev/null || true; fi
    if [[ "$namespace" == container ]]; then
      stored_id=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-ids.tsv")
      current_id=$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null || true)
      if [[ "$current_id" == "$stored_id" ]]; then
        group_exec "$namespace" "$container" nft delete table inet "$NFTABLES_TABLE" >/dev/null 2>&1 || true
        if network_exists "$PROXY_NETWORK"; then docker network disconnect -f "$PROXY_NETWORK" "$container" >/dev/null 2>&1 || true; fi
      elif [[ "$allow_source_change" != true ]]; then
        echo "rollback=FAIL: source container changed: $container" >&2; ok=false
      fi
    else
      group_exec host none nft delete table inet "$NFTABLES_TABLE" >/dev/null 2>&1 || true
    fi
  done < <(groups_tsv)
  if owned_container "$EGRESS_NAME"; then docker rm -f "$EGRESS_NAME" >/dev/null || true; fi
  if network_exists "$PROXY_NETWORK"; then docker network rm "$PROXY_NETWORK" >/dev/null 2>&1 || true; fi
  if network_exists "$CONTROL_NETWORK"; then docker network rm "$CONTROL_NETWORK" >/dev/null 2>&1 || true; fi
  rm -f "$EGRESS_PROXY_IP_FILE"
  owned_absent || ok=false
  [[ "$allow_source_change" == true ]] || verify_baseline "$backup" || ok=false
  if [[ "$ok" != true ]]; then write_manifest rollback_failed "$backup"; echo 'rollback=FAIL' >&2; return 1; fi
  local status=rolled_back; [[ "$command_name" == disable ]] && status=disabled
  write_manifest "$status" "$backup"
  [[ "$deadman_call" == true ]] || cancel_deadman
  if [[ "$command_name" == disable ]]; then
    systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
    systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
  fi
  [[ "$command_name" == disable ]] && echo 'disable=PASS' || echo 'rollback=PASS'
}

apply_runtime() {
  local backup tag namespace container source_tag capture dns
  if [[ -f "$MANIFEST" ]]; then
    # shellcheck disable=SC1090
    source "$MANIFEST"
    if [[ "$MANIFEST_STATUS" == applied ]]; then verify_applied && { echo 'enable=ALREADY_ENABLED'; return 0; }; echo 'enable=FAIL: applied manifest is drifted; rollback first' >&2; return 1; fi
  fi
  preflight >/dev/null
  mkdir -p "$RUNTIME_DIR/backups" "$RUNTIME_DIR/rollback-verification"; chmod 700 "$STATE_ROOT" "$RUNTIME_DIR" "$RUNTIME_DIR/backups" "$RUNTIME_DIR/rollback-verification"
  if [[ $(json_value config_schema_version) == 3.0 ]]; then
    refresh_routing_data "$DATA_STATE"
    render_artifacts "$DATA_STATE"
  fi
  cp "$config_path" "$STORED_CONFIG"; cp "$plan_tmp" "$STORED_PLAN"; chmod 600 "$STORED_CONFIG" "$STORED_PLAN"
  backup=$(capture_baseline)
  write_manifest applying "$backup"
  arm_deadman "$rollback_after"
  if ! { start_egress; pin_tailscale_proxy_ip; attach_sources; while IFS=$'\t' read -r tag namespace container source_tag capture dns; do start_group "$tag" "$namespace" "$container" "$source_tag" "$capture" "$dns"; done < <(groups_tsv); }; then
    capture_failure_diagnostics apply_failed
    rollback_runtime true || true
    echo 'enable=FAIL: runtime apply failed and rollback was attempted' >&2
    return 1
  fi
  write_manifest applied "$backup"
  verify_applied || { capture_failure_diagnostics verification_failed; rollback_runtime false || true; echo 'enable=FAIL: verification failed and rollback was attempted' >&2; return 1; }
  echo 'enable=PASS'
}

repair_applied_runtime() {
  local preflight_done=${1:-false}
  local tag namespace container source_tag capture dns backup stored_id current_id stored_namespace current_namespace table_present=false rebuild=false repaired=false identity_changed=false
  require_manifest_match || { echo 'reconcile=FAIL: manifest or configuration mismatch' >&2; return 1; }
  # shellcheck disable=SC1090
  source "$MANIFEST"
  [[ "$MANIFEST_STATUS" == applied ]] || { echo "reconcile=FAIL: manifest status is $MANIFEST_STATUS" >&2; return 1; }
  backup=$MANIFEST_BACKUP_DIR
  mkdir -p "$RUNTIME_DIR/recovery-evidence"; chmod 700 "$RUNTIME_DIR/recovery-evidence"
  [[ "$preflight_done" == true ]] || preflight >/dev/null

  if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]]; then
    owned_container "$EGRESS_NAME" || { echo 'reconcile=FAIL: managed egress is missing or not owned' >&2; return 1; }
    if ! container_running "$EGRESS_NAME"; then docker start "$EGRESS_NAME" >/dev/null; repaired=true; fi
    wait_tailscale_ready || { echo 'reconcile=FAIL: managed egress did not become ready' >&2; return 1; }
    pin_tailscale_proxy_ip
  fi

  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    rebuild=false; table_present=false; identity_changed=false
    group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1 && table_present=true
    if [[ "$namespace" == container ]]; then
      stored_id=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-ids.tsv")
      stored_namespace=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-namespaces.tsv" 2>/dev/null || true)
      current_id=$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null || true)
      current_namespace=$(namespace_identity "$namespace" "$container" 2>/dev/null || true)
      if [[ -n "$stored_namespace" ]]; then
        [[ "$stored_id" == "$current_id" && "$stored_namespace" == "$current_namespace" ]] || identity_changed=true
      elif [[ "$stored_id" != "$current_id" || "$table_present" != true ]]; then
        identity_changed=true
      fi
      if [[ "$identity_changed" == true && "$table_present" == true ]]; then
        echo "reconcile=FAIL: replacement namespace already contains the project nftables table for source group $tag" >&2
        return 1
      fi
      if [[ "$identity_changed" == true ]]; then
        if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]] && source_on_proxy_network "$container"; then
          docker network disconnect -f "$PROXY_NETWORK" "$container"
        fi
        refresh_source_baseline "$backup" "$tag" "$namespace" "$container"
        rebuild=true
      fi
      if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]] && ! source_on_proxy_network "$container"; then
        docker network connect --gw-priority -1 "$PROXY_NETWORK" "$container"
        rebuild=true
      fi
    fi
    [[ "$table_present" == true ]] || rebuild=true
    container_running "$capture" && owned_container "$capture" || rebuild=true
    if [[ "$MANAGED_DNS" == true ]]; then container_running "$dns" && owned_container "$dns" || rebuild=true; fi
    if [[ "$rebuild" == true ]]; then
      for name in "$capture" "$dns"; do
        if docker inspect "$name" >/dev/null 2>&1; then
          owned_container "$name" || { echo "reconcile=FAIL: sidecar name is not project-owned: $name" >&2; return 1; }
          docker rm -f "$name" >/dev/null
        fi
      done
      start_group "$tag" "$namespace" "$container" "$source_tag" "$capture" "$dns"
      repaired=true
    fi
  done < <(groups_tsv)

  write_manifest applied "$backup"
  if ! verify_applied; then
    capture_failure_diagnostics reconcile_verification_failed
    echo 'reconcile=FAIL: targeted recovery did not pass verification; fail-closed resources were preserved' >&2
    return 1
  fi
  if [[ "$repaired" == true ]]; then echo 'reconcile=RECOVERED'; else echo 'reconcile=IDENTITY_RECORDED'; fi
}

recover_runtime() {
  if [[ $(manifest_status 2>/dev/null || true) != applied ]]; then
    echo 'watchdog=NO_ACTION'
    return 0
  fi
  if status_runtime >/dev/null 2>&1; then
    echo 'watchdog=HEALTHY'
    return 0
  fi
  if ! preflight >/dev/null 2>&1; then
    echo 'watchdog=DEFERRED'
    return 0
  fi
  if ! repair_applied_runtime true; then
    echo 'watchdog=FAILED' >&2
    return 1
  fi
  cancel_deadman
  echo 'watchdog=RECOVERED'
}

status_runtime() {
  local status=absent tag namespace container source_tag capture dns capture_state dns_state table_state identity_state stored_id current_id stored_namespace current_namespace ok=true
  status=$(manifest_status 2>/dev/null || printf absent)
  echo "status=$status"
  echo "source_groups=$(groups_tsv | wc -l | tr -d ' ')"
  if [[ $(json_value config_schema_version) == 3.0 ]]; then
    "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status --config "$config_path" --state "$DATA_STATE" | sed 's/^/data./' || ok=false
  else
    echo 'data_status=not_applicable'
  fi
  while IFS=$'\t' read -r tag namespace container source_tag capture dns; do
    container_running "$capture" && capture_state=running || capture_state=stopped
    if [[ "$MANAGED_DNS" == true ]]; then container_running "$dns" && dns_state=running || dns_state=stopped; else dns_state=not_applicable; fi
    group_exec "$namespace" "$container" nft list table inet "$NFTABLES_TABLE" >/dev/null 2>&1 && table_state=present || table_state=absent
    identity_state=not_applicable
    if [[ "$namespace" == container && "$status" == applied ]]; then
      stored_id=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-ids.tsv" 2>/dev/null || true)
      stored_namespace=$(awk -F= -v tag="$tag" '$1==tag{print $2}' "$RUNTIME_DIR/source-namespaces.tsv" 2>/dev/null || true)
      current_id=$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null || true)
      current_namespace=$(namespace_identity "$namespace" "$container" 2>/dev/null || true)
      if [[ -z "$stored_namespace" ]]; then identity_state=unrecorded
      elif [[ "$stored_id" == "$current_id" && "$stored_namespace" == "$current_namespace" ]]; then identity_state=matched
      else identity_state=changed
      fi
    fi
    if [[ "$status" == applied ]]; then
      [[ "$capture_state" == running && "$table_state" == present ]] || ok=false
      [[ "$MANAGED_DNS" != true || "$dns_state" == running ]] || ok=false
      [[ "$namespace" != container || "$identity_state" == matched ]] || ok=false
    fi
    echo "source.$tag.namespace=$namespace"
    echo "source.$tag.capture=$capture_state"
    echo "source.$tag.dns=$dns_state"
    echo "source.$tag.nftables=$table_state"
    echo "source.$tag.namespace_identity=$identity_state"
  done < <(groups_tsv)
  if [[ "$status" == applied ]]; then
    require_manifest_match || ok=false
    if [[ "$STRICT_EGRESS_TYPE" == tailscale_socks ]]; then
      container_running "$EGRESS_NAME" && owned_container "$EGRESS_NAME" || ok=false
    fi
    [[ "$ok" == true ]] || { echo 'status_health=drifted'; return 1; }
    echo 'status_health=structurally_healthy'
  fi
}

case "$command_name" in
  preflight) preflight ;;
  enable|apply) apply_runtime ;;
  disable) rollback_runtime false ;;
  rollback) rollback_runtime false ;;
  status) status_runtime ;;
  verify) verify_applied; [[ "$cancel_deadman" == true ]] && { cancel_deadman; echo 'deadman=CANCELLED'; }; echo 'verify=PASS' ;;
  recover) recover_runtime ;;
  reconcile)
    if verify_applied; then
      echo 'reconcile=NO_CHANGE'
    elif [[ $(manifest_status 2>/dev/null || true) == applied ]]; then
      repair_applied_runtime
    else
      rollback_runtime true
      apply_runtime
      echo 'reconcile=PASS'
    fi
    ;;
esac
