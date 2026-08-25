#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
node_bin=${VPN_ROUTER_NODE:-node}
default_config=${VPN_ROUTER_CONFIG:-/etc/vpn-router/router.yaml}
active_config_file=${VPN_ROUTER_ACTIVE_CONFIG_FILE:-/var/lib/vpn-router-installer/active-config}

usage() {
  cat >&2 <<'EOF'
Usage:
  vpn-router version
  vpn-router discover [--json]
  vpn-router setup [options]
  vpn-router configure [wizard options]
  vpn-router migrate-config --input <path> --output <path>
  vpn-router data-update|data-status [--config <path>] [--json]
  vpn-router diagnose <domain> [--config <path>] [--json]
  vpn-router validate [--config <path>]
  vpn-router doctor [--config <path>]
  vpn-router preflight|enable|disable|rollback|reconcile [options]
  vpn-router status [--json] [--config <path>]
  vpn-router verify [--full] [--config <path>] [--cancel-deadman]
  vpn-router service-enable [--config <path>]
  vpn-router service-disable
  vpn-router service-status

Lifecycle commands use /etc/vpn-router/router.yaml unless --config is given.
Enable and reconcile require --rollback-after <60-3600>.
EOF
}

command_name=${1-}
if [[ -n "$command_name" ]]; then shift; fi

config_args() {
  local argument
  for argument in "$@"; do
    [[ "$argument" == --config ]] && return 0
  done
  return 1
}

run_lifecycle() {
  if config_args "$@"; then
    exec "$script_dir/vpn-router-lifecycle.sh" "$command_name" "$@"
  fi
  exec "$script_dir/vpn-router-lifecycle.sh" "$command_name" --config "$default_config" "$@"
}

config_value_from_args() {
  local fallback=$1 argument next=false
  shift
  for argument in "$@"; do
    if [[ "$next" == true ]]; then printf '%s\n' "$argument"; return 0; fi
    [[ "$argument" != --config ]] || next=true
  done
  printf '%s\n' "$fallback"
}

canonical_config_path() {
  local value=$1
  [[ "$value" != *$'\n'* && -f "$value" ]] || { echo 'active-config=FAIL: configuration path is invalid' >&2; return 1; }
  printf '%s/%s\n' "$(cd -- "$(dirname -- "$value")" && pwd)" "$(basename -- "$value")"
}

record_active_config() {
  local value=$1 directory temporary
  value=$(canonical_config_path "$value")
  directory=$(dirname -- "$active_config_file")
  temporary="$active_config_file.$$.tmp"
  mkdir -p -- "$directory"
  chmod 700 "$directory"
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$active_config_file"
}

clear_active_config() {
  local value=$1 recorded=''
  value=$(canonical_config_path "$value")
  [[ ! -f "$active_config_file" ]] || IFS= read -r recorded <"$active_config_file"
  [[ -n "$recorded" && "$recorded" != "$value" ]] || rm -f -- "$active_config_file"
}

start_data_timer() {
  local config=$1
  [[ -f /etc/systemd/system/vpn-router-data-update.timer ]] || return 0
  record_active_config "$config"
  if ! systemctl enable --now vpn-router-data-update.timer; then
    clear_active_config "$config"
    return 1
  fi
}

case "$command_name" in
  version)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    cat "$repo_dir/VERSION"
    ;;
  configure)
    exec "$node_bin" "$repo_dir/bin/vpn-router-configure.mjs" "$@"
    ;;
  setup)
    exec "$node_bin" "$repo_dir/bin/vpn-router-configure.mjs" \
      --preset amnezia-tailscale \
      --output "$default_config" \
      "$@"
    ;;
  discover)
    exec "$node_bin" "$repo_dir/bin/vpn-router-discover.mjs" "$@"
    ;;
  validate)
    if config_args "$@"; then
      exec "$node_bin" "$repo_dir/bin/vpn-router.mjs" validate "$@"
    fi
    exec "$node_bin" "$repo_dir/bin/vpn-router.mjs" validate --config "$default_config" "$@"
    ;;
  migrate-config)
    exec "$node_bin" "$repo_dir/bin/vpn-router.mjs" migrate-config "$@"
    ;;
  data-update)
    if config_args "$@"; then exec "$script_dir/vpn-router-data-update.sh" "$@"; fi
    exec "$script_dir/vpn-router-data-update.sh" --config "$default_config"
    ;;
  data-status)
    if config_args "$@"; then exec "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status "$@"; fi
    exec "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status --config "$default_config" "$@"
    ;;
  diagnose)
    domain=${1-}
    [[ -n "$domain" ]] || { usage; exit 2; }
    shift
    if config_args "$@"; then exec "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" diagnose "$domain" "$@"; fi
    exec "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" diagnose "$domain" --config "$default_config" "$@"
    ;;
  doctor)
    if config_args "$@"; then
      "$node_bin" "$repo_dir/bin/vpn-router.mjs" validate "$@"
      "$script_dir/vpn-router-lifecycle.sh" preflight "$@"
    else
      "$node_bin" "$repo_dir/bin/vpn-router.mjs" validate --config "$default_config" "$@"
      "$script_dir/vpn-router-lifecycle.sh" preflight --config "$default_config" "$@"
    fi
    echo 'doctor=PASS'
    echo 'next=enable with a server-side rollback timer'
    ;;
  status)
    json=false
    status_args=()
    for argument in "$@"; do
      if [[ "$argument" == --json ]]; then json=true; else status_args+=("$argument"); fi
    done
    if [[ "$json" == false ]]; then run_lifecycle "${status_args[@]}"; fi
    if config_args "${status_args[@]}"; then
      output=$("$script_dir/vpn-router-lifecycle.sh" status "${status_args[@]}")
    else
      output=$("$script_dir/vpn-router-lifecycle.sh" status --config "$default_config" "${status_args[@]}")
    fi
    printf '%s\n' "$output" | "$node_bin" -e '
      let text="";process.stdin.on("data",chunk=>text+=chunk).on("end",()=>{
        const result={}; for(const line of text.trim().split(/\n/)){const at=line.indexOf("=");if(at>0)result[line.slice(0,at)]=line.slice(at+1)}
        process.stdout.write(JSON.stringify(result)+"\n");
      });'
    ;;
  verify)
    full=false
    verify_args=()
    for argument in "$@"; do
      if [[ "$argument" == --full ]]; then full=true; else verify_args+=("$argument"); fi
    done
    command_name=verify
    if [[ "$full" == false ]]; then run_lifecycle "${verify_args[@]}"; fi
    if config_args "${verify_args[@]}"; then
      "$script_dir/vpn-router-lifecycle.sh" verify "${verify_args[@]}"
      config_value=''
      for ((index=0; index<${#verify_args[@]}; index++)); do [[ "${verify_args[$index]}" != --config ]] || config_value=${verify_args[$((index+1))]}; done
    else
      "$script_dir/vpn-router-lifecycle.sh" verify --config "$default_config" "${verify_args[@]}"
      config_value=$default_config
    fi
    "$node_bin" "$repo_dir/bin/vpn-router-data.mjs" status --config "$config_value"
    echo 'verify_full=PASS'
    ;;
  disable)
    disable_config=$(config_value_from_args "$default_config" "$@")
    systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
    systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
    if config_args "$@"; then
      "$script_dir/vpn-router-lifecycle.sh" disable "$@"
    else
      "$script_dir/vpn-router-lifecycle.sh" disable --config "$default_config" "$@"
    fi
    clear_active_config "$disable_config"
    ;;
  enable)
    if config_args "$@"; then
      "$script_dir/vpn-router-lifecycle.sh" enable "$@"
      enable_config=''
      enable_args=("$@")
      for ((index=0; index<${#enable_args[@]}; index++)); do [[ "${enable_args[$index]}" != --config ]] || enable_config=${enable_args[$((index+1))]}; done
    else
      "$script_dir/vpn-router-lifecycle.sh" enable --config "$default_config" "$@"
      enable_config=$default_config
    fi
    if ! start_data_timer "$enable_config"; then
      "$script_dir/vpn-router-lifecycle.sh" disable --config "$enable_config" >/dev/null 2>&1 || true
      echo 'enable=FAIL: data updater could not start; routing was disabled again' >&2
      exit 1
    fi
    ;;
  rollback)
    rollback_config=$(config_value_from_args "$default_config" "$@")
    systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
    systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
    if config_args "$@"; then
      "$script_dir/vpn-router-lifecycle.sh" rollback "$@"
    else
      "$script_dir/vpn-router-lifecycle.sh" rollback --config "$default_config" "$@"
    fi
    clear_active_config "$rollback_config"
    ;;
  reconcile)
    reconcile_config=$(config_value_from_args "$default_config" "$@")
    if config_args "$@"; then
      "$script_dir/vpn-router-lifecycle.sh" reconcile "$@"
    else
      "$script_dir/vpn-router-lifecycle.sh" reconcile --config "$default_config" "$@"
    fi
    if ! start_data_timer "$reconcile_config"; then
      echo 'reconcile=FAIL: routing data timer could not start' >&2
      exit 1
    fi
    ;;
  preflight)
    run_lifecycle "$@"
    ;;
  service-enable)
    [[ $EUID -eq 0 ]] || { echo 'service-enable=FAIL: root privileges are required' >&2; exit 1; }
    if config_args "$@"; then
      echo 'service-enable=FAIL: systemd uses the installed configuration path; copy the validated config there first' >&2
      exit 2
    fi
    [[ $# -eq 0 ]] || { usage; exit 2; }
    "$node_bin" "$repo_dir/bin/vpn-router.mjs" validate --config "$default_config" >/dev/null
    record_active_config "$default_config"
    if ! systemctl enable --now vpn-router.service; then
      clear_active_config "$default_config"
      echo 'service-enable=FAIL: routing service could not start' >&2
      exit 1
    fi
    if ! systemctl enable --now vpn-router-watchdog.timer; then
      systemctl disable --now vpn-router.service >/dev/null 2>&1 || true
      clear_active_config "$default_config"
      echo 'service-enable=FAIL: watchdog timer could not start; routing was disabled again' >&2
      exit 1
    fi
    if ! systemctl enable --now vpn-router-data-update.timer; then
      systemctl disable --now vpn-router-watchdog.timer vpn-router.service >/dev/null 2>&1 || true
      clear_active_config "$default_config"
      echo 'service-enable=FAIL: routing data timer could not start; routing was disabled again' >&2
      exit 1
    fi
    echo 'service-enable=PASS'
    ;;
  service-disable)
    [[ $EUID -eq 0 ]] || { echo 'service-disable=FAIL: root privileges are required' >&2; exit 1; }
    [[ $# -eq 0 ]] || { usage; exit 2; }
    systemctl disable --now vpn-router-watchdog.timer >/dev/null 2>&1 || true
    systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
    systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
    systemctl disable --now vpn-router.service
    clear_active_config "$default_config"
    echo 'service-disable=PASS'
    ;;
  service-status)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    exec systemctl status vpn-router.service vpn-router-watchdog.timer vpn-router-data-update.timer
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
