#!/usr/bin/env sh
set -eu

compose_file="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/compose.yaml"

docker compose -f "$compose_file" up -d
sleep 5

docker compose -f "$compose_file" exec -T source sh -c "printf routed-probe | ip netns exec awg-client nc -w 3 172.30.20.20 18080"
sleep 1
docker compose -f "$compose_file" exec -T target grep -q routed-probe /tmp/target.log

docker compose -f "$compose_file" stop sidecar >/dev/null
if docker compose -f "$compose_file" exec -T source sh -c "printf blocked-probe | ip netns exec awg-client nc -w 2 172.30.20.20 18080"; then
  echo "FAIL: strict traffic reached the target after the sidecar stopped" >&2
  exit 1
fi
sleep 1
if docker compose -f "$compose_file" exec -T target grep -q blocked-probe /tmp/target.log; then
  echo "FAIL: strict traffic leaked to the target after the sidecar stopped" >&2
  exit 1
fi

echo "PASS: strict traffic was routed through TPROXY and failed closed after sidecar stop."
