#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
config_path=${VPN_ROUTER_CONFIG:-/etc/vpn-router/router.yaml}

exec "$script_dir/vpn-router-lifecycle.sh" recover --config "$config_path"
