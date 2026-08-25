#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
node_bin=${VPN_ROUTER_NODE:-node}
active_config_file=${VPN_ROUTER_ACTIVE_CONFIG_FILE:-/var/lib/vpn-router-installer/active-config}
config_path=${VPN_ROUTER_CONFIG-}

if [[ -z "$config_path" && -f "$active_config_file" ]]; then
  IFS= read -r config_path <"$active_config_file"
fi
config_path=${config_path:-/etc/vpn-router/router.yaml}

usage() {
  echo 'Usage: vpn-router-data-update.sh [--config <router.yaml>]' >&2
}

if (($# > 0)); then
  [[ $# -eq 2 && $1 == --config && -f $2 ]] || { usage; exit 2; }
  config_path=$2
fi
config_path=$(cd -- "$(dirname -- "$config_path")" && pwd)/$(basename -- "$config_path")

command -v flock >/dev/null
lock_key=$(printf '%s' "$config_path" | sha256sum | awk '{print substr($1,1,16)}')
exec 9>"/run/lock/vpn-router-$lock_key.lock"
flock -n 9 || { echo 'data-update=FAIL: another lifecycle operation is running' >&2; exit 1; }

eval "$("$node_bin" "$repo_dir/bin/vpn-router.mjs" render-runtime-env --config "$config_path")"
[[ "$CONFIG_SCHEMA_VERSION" == 3.0 ]] || { echo 'data-update=NOT_APPLICABLE'; exit 0; }

state_root="/var/lib/$SERVICE_NAME"
data_dir="$state_root/data"
state="$data_dir/state.json"
runtime_dir="$state_root/runtime"
manifest="$runtime_dir/multi-source-manifest.env"
stored_config="$runtime_dir/multi-source-config.yaml"
work_dir=$(mktemp -d /tmp/vpn-router-data-update.XXXXXX)
chmod 700 "$work_dir"
plan="$work_dir/plan.json"
next="$work_dir/state.json"
next_rules="$work_dir/next.nft"
old_rules="$work_dir/old.nft"
applied="$work_dir/applied.tsv"
state_new="$state.new"
cleanup() { rm -rf "$work_dir"; rm -f "$state_new"; }
trap cleanup EXIT
touch "$plan" "$next_rules" "$old_rules" "$applied"
chmod 600 "$plan" "$next_rules" "$old_rules" "$applied"

mkdir -p "$data_dir"
chmod 700 "$state_root" "$data_dir"
[[ ! -f "$state" ]] || { cp "$state" "$next"; chmod 600 "$next"; }
"$node_bin" "$repo_dir/bin/vpn-router-data.mjs" update --config "$config_path" --state "$next" >/dev/null
"$node_bin" "$repo_dir/bin/vpn-router.mjs" render-data-update --config "$config_path" --routing-data "$next" >"$next_rules"

active=false
if [[ -f "$manifest" ]]; then
  # shellcheck disable=SC1090
  source "$manifest"
  if [[ "${MANIFEST_STATUS-}" == applied ]]; then
    [[ -f "$stored_config" && "${MANIFEST_CONFIG_SHA256-}" == "$(sha256sum "$config_path" | awk '{print $1}')" ]] || {
      echo 'data-update=FAIL: active manifest does not match the configuration' >&2
      exit 1
    }
    [[ -f "$state" ]] || { echo 'data-update=FAIL: active schema 3 runtime has no previous data state' >&2; exit 1; }
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-data-restore --config "$config_path" --routing-data "$state" >"$old_rules"
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" render-runtime-plan --config "$config_path" >"$plan"
    active=true
  fi
fi

groups() {
  "$node_bin" -e '
    const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    for(const g of p.groups) console.log([g.tag,g.namespace,g.container_name??"none"].join("\t"));
  ' "$plan"
}

restore_applied_groups() {
  local rollback_ok=true _tag namespace container
  while IFS=$'\t' read -r _tag namespace container; do
    group_nft "$namespace" "$container" -f "$old_rules" || rollback_ok=false
  done <"$applied"
  [[ "$rollback_ok" == true ]]
}

group_nft() {
  local namespace=$1 container=$2; shift 2
  if [[ "$namespace" == host ]]; then nft "$@"; else nsenter --target "$(docker inspect -f '{{.State.Pid}}' "$container")" --net -- nft "$@"; fi
}

install -m 600 "$next" "$state_new"

if [[ "$active" == true ]]; then
  while IFS=$'\t' read -r _tag namespace container; do group_nft "$namespace" "$container" -c -f "$next_rules"; done < <(groups)
  while IFS=$'\t' read -r tag namespace container; do
    if group_nft "$namespace" "$container" -f "$next_rules"; then
      printf '%s\t%s\t%s\n' "$tag" "$namespace" "$container" >>"$applied"
    else
      if restore_applied_groups; then
        echo "data-update=FAIL: nftables update failed for source group $tag; previous data was restored" >&2
      else
        echo "data-update=FAIL: nftables update and compensation failed for source group $tag; fail-closed rules remain but operator recovery is required" >&2
      fi
      exit 1
    fi
  done < <(groups)
fi

if ! mv -f "$state_new" "$state"; then
  [[ "$active" != true ]] || restore_applied_groups || true
  echo 'data-update=FAIL: state activation failed; previous nftables data was restored when possible' >&2
  exit 1
fi
echo 'data-update=PASS'
"$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status --config "$config_path" --state "$state"
