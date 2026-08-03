#!/usr/bin/env sh
set -eu

CDPATH=''
export CDPATH
compose_file="$(cd -- "$(dirname -- "$0")" && pwd)/compose.yaml"
project_name='vpn-router-namespace-lab'

capture_file=$(mktemp)
cleanup() {
  if [ -f "$capture_file" ]; then unlink "$capture_file"; fi
  docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$compose_file" up -d --wait

source_ns="$(docker compose -f "$compose_file" exec -T source readlink /proc/1/ns/net)"
sidecar_ns="$(docker compose -f "$compose_file" exec -T sidecar readlink /proc/1/ns/net)"

if [ "$source_ns" != "$sidecar_ns" ]; then
  echo "FAIL: sidecar did not join the source network namespace" >&2
  exit 1
fi

docker compose -f "$compose_file" exec -T sidecar ip -o link show dev awg0 >/dev/null
docker compose -f "$compose_file" exec -T sidecar ip -o -4 addr show dev awg0 | grep -q '10\.8\.1\.1/24'

docker compose -f "$compose_file" exec -T sidecar tcpdump -n -l -i awg0 -c 1 'tcp port 18080' >"$capture_file" 2>&1 &
capture_pid=$!
sleep 1
docker compose -f "$compose_file" exec -T source sh -c "printf probe | ip netns exec awg-client nc -w 2 10.8.1.1 18080"
wait "$capture_pid"

if ! grep -Eq '10\.8\.1\.2\.[0-9]+ > 10\.8\.1\.1\.18080' "$capture_file"; then
  cat "$capture_file" >&2
  echo "FAIL: sidecar did not capture the original client source on awg0" >&2
  exit 1
fi

docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null
trap - EXIT INT TERM
if [ -f "$capture_file" ]; then unlink "$capture_file"; fi

if docker ps -a --filter "label=com.docker.compose.project=$project_name" --format '{{.ID}}' | grep -q .; then
  echo "FAIL: project containers remain after cleanup" >&2
  exit 1
fi

echo "PASS: sidecar captured 10.8.1.2 traffic on awg0 before NAT and cleanup completed."
