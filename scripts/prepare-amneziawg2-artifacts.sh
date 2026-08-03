#!/usr/bin/env sh
set -eu

CDPATH=''
export CDPATH
umask 077

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)

config_path=""
output_dir=""

usage() {
  echo "Usage: $0 --config <router.yaml> --output-dir <directory>" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      config_path=$2
      shift 2
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      output_dir=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "$config_path" ] || [ -z "$output_dir" ]; then
  usage
  exit 2
fi

mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
chmod 700 "$output_dir"
config_path=$(cd -- "$(dirname -- "$config_path")" && pwd)/$(basename -- "$config_path")
node "$repo_dir/bin/vpn-router.mjs" validate --config "$config_path"
node "$repo_dir/bin/vpn-router.mjs" render-sing-box --config "$config_path" > "$output_dir/sing-box.json"
node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$config_path" > "$output_dir/vpn-router.nft"
node "$repo_dir/bin/vpn-router.mjs" render-dnsmasq --config "$config_path" > "$output_dir/dnsmasq.conf"
node "$repo_dir/bin/vpn-router.mjs" render-runtime-env --config "$config_path" > "$output_dir/runtime.env"
chmod 600 "$output_dir/sing-box.json" "$output_dir/vpn-router.nft" "$output_dir/dnsmasq.conf" "$output_dir/runtime.env"

docker run --rm -v "$output_dir/sing-box.json:/config.json:ro" ghcr.io/sagernet/sing-box@sha256:da0e2331395c9025a85fa58892772b4cdbe5f2e530e93defeec3968175d06c6d check -c /config.json
docker build -t vpn-router-dns:local-check "$repo_dir/deploy/dnsmasq" >/dev/null
docker run --rm --entrypoint nft --cap-add NET_ADMIN -v "$output_dir/vpn-router.nft:/rules.nft:ro" vpn-router-dns:local-check -c -f /rules.nft
docker run --rm -v "$output_dir/dnsmasq.conf:/etc/dnsmasq.conf:ro" vpn-router-dns:local-check --test

printf '%s\n' "PASS: validated deployment artifacts are in $output_dir"
