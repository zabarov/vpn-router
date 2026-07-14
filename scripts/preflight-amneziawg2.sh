#!/usr/bin/env sh
set -eu

container_name=""
interface_name="awg0"

usage() {
  echo "Usage: $0 --container <docker-container> [--interface awg0]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container)
      container_name="${2-}"
      shift 2
      ;;
    --interface)
      interface_name="${2-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "$container_name" ]; then
  usage
  exit 2
fi

if ! docker inspect "$container_name" >/dev/null 2>&1; then
  echo "FAIL: Docker container not found: $container_name" >&2
  exit 1
fi

if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]; then
  echo "FAIL: Docker container is not running: $container_name" >&2
  exit 1
fi

if ! docker exec "$container_name" ip -o link show dev "$interface_name" >/dev/null 2>&1; then
  echo "FAIL: interface $interface_name is not available in $container_name" >&2
  exit 1
fi

if ! docker exec "$container_name" ip -o -4 addr show dev "$interface_name" | grep -q 'inet '; then
  echo "FAIL: interface $interface_name has no IPv4 address" >&2
  exit 1
fi

echo "PASS: $container_name is running and exposes $interface_name inside its network namespace."
echo "Read-only inventory:"
docker inspect --format 'image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}}' "$container_name"
docker exec "$container_name" ip -o -4 addr show dev "$interface_name"
docker exec "$container_name" ip route show
