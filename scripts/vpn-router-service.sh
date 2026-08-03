#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
action=${1-}
config_path=${VPN_ROUTER_CONFIG:-/etc/vpn-router/router.yaml}
rollback_after=${VPN_ROUTER_BOOT_ROLLBACK_AFTER:-600}
wait_seconds=${VPN_ROUTER_BOOT_WAIT_SECONDS:-180}

case "$action" in
  start)
    deadline=$((SECONDS + wait_seconds))
    while ! "$script_dir/vpn-router-lifecycle.sh" preflight --config "$config_path" >/dev/null 2>&1; do
      if ((SECONDS >= deadline)); then
        echo 'service-start=FAIL: preflight did not become ready before the boot deadline' >&2
        exit 1
      fi
      sleep 5
    done
    "$script_dir/vpn-router-lifecycle.sh" reconcile --config "$config_path" --rollback-after "$rollback_after"
    "$script_dir/vpn-router-lifecycle.sh" verify --config "$config_path" --cancel-deadman
    echo 'service-start=PASS'
    ;;
  stop)
    "$script_dir/vpn-router-lifecycle.sh" disable --config "$config_path"
    echo 'service-stop=PASS'
    ;;
  *)
    echo 'Usage: vpn-router-service.sh <start|stop>' >&2
    exit 2
    ;;
esac
