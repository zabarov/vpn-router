#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
node_bin=${VPN_ROUTER_NODE:-node}
default_config=${VPN_ROUTER_CONFIG:-/etc/vpn-router/router.yaml}

usage() {
  cat >&2 <<'EOF'
Usage:
  vpn-router version
  vpn-router discover [--json]
  vpn-router configure [wizard options]
  vpn-router validate [--config <path>]
  vpn-router doctor [--config <path>]
  vpn-router preflight|enable|disable|status|verify|rollback|reconcile [options]
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

case "$command_name" in
  version)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    cat "$repo_dir/VERSION"
    ;;
  configure)
    exec "$node_bin" "$repo_dir/bin/vpn-router-configure.mjs" "$@"
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
  preflight|enable|disable|status|verify|rollback|reconcile)
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
    systemctl enable --now vpn-router.service
    echo 'service-enable=PASS'
    ;;
  service-disable)
    [[ $EUID -eq 0 ]] || { echo 'service-disable=FAIL: root privileges are required' >&2; exit 1; }
    [[ $# -eq 0 ]] || { usage; exit 2; }
    systemctl disable --now vpn-router.service
    echo 'service-disable=PASS'
    ;;
  service-status)
    [[ $# -eq 0 ]] || { usage; exit 2; }
    exec systemctl status vpn-router.service
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
