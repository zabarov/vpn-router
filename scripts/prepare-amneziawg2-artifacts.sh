#!/usr/bin/env sh
set -eu

config_path=""
output_dir=""

usage() {
  echo "Usage: $0 --config <router.yaml> --output-dir <directory>" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) config_path="${2-}"; shift 2 ;;
    --output-dir) output_dir="${2-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "$config_path" ] || [ -z "$output_dir" ]; then
  usage
  exit 2
fi

mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
node bin/vpn-router.mjs validate --config "$config_path"
node bin/vpn-router.mjs render-sing-box --config "$config_path" > "$output_dir/sing-box.json"
node bin/vpn-router.mjs render-nftables --config "$config_path" > "$output_dir/vpn-router.nft"
node bin/vpn-router.mjs render-dnsmasq --config "$config_path" > "$output_dir/dnsmasq.conf"

docker run --rm -v "$output_dir/sing-box.json:/config.json:ro" ghcr.io/sagernet/sing-box:v1.13.12 check -c /config.json
docker run --rm --cap-add NET_ADMIN -v "$output_dir/vpn-router.nft:/rules.nft:ro" alpine:3.21 sh -ec 'apk add --no-cache nftables >/dev/null && nft -c -f /rules.nft'
docker build -t vpn-router-dns:local-check deploy/dnsmasq >/dev/null
docker run --rm -v "$output_dir/dnsmasq.conf:/etc/dnsmasq.conf:ro" vpn-router-dns:local-check --test

printf '%s\n' "PASS: validated deployment artifacts are in $output_dir"
