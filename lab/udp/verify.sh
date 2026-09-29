#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "$0")/../.." && pwd)
name="vpn-router-udp-lab-$$"
cleanup() {
  if [[ ${KEEP_LAB:-0} == 1 ]]; then echo "lab_container=$name"; return; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$name" --privileged -v "$repo_dir:/repo:ro" \
  alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d \
  sleep infinity >/dev/null
docker exec "$name" apk add --no-cache iproute2 nftables python3 util-linux >/dev/null
docker exec "$name" sh /repo/lab/udp/setup.sh
docker exec "$name" ip netns exec egress ip -4 route get 10.42.0.2 | grep -Fq 'dev vrudp1'
docker exec "$name" ip netns exec egress ip -4 route get 172.19.0.3 | grep -Fq 'dev eg-proxy'
docker exec "$name" ip netns exec egress ip rule del to 172.19.0.0/24 priority 490
docker exec "$name" ip netns exec egress ip -4 route get 172.19.0.3 | grep -Fq 'dev tailscale0'
docker exec "$name" ip netns exec egress ip rule add to 172.19.0.0/24 lookup main priority 490
node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$repo_dir/examples/config.sip-udp.yaml" |
  docker exec -i "$name" ip netns exec source nft -f -
node "$repo_dir/bin/vpn-router.mjs" render-udp-egress --config "$repo_dir/examples/config.sip-udp.yaml" |
  docker exec -i "$name" ip netns exec egress nft -f -

docker exec -d "$name" ip netns exec exit python3 /repo/lab/udp/echo.py exit 198.51.100.10 5060
docker exec -d "$name" ip netns exec exit python3 /repo/lab/udp/echo.py exit 198.51.100.10 5061
docker exec -d "$name" ip netns exec exit python3 /repo/lab/udp/echo.py exit 198.51.100.10 10000
docker exec -d "$name" ip netns exec exit python3 /repo/lab/udp/echo.py exit 198.51.100.10 443
docker exec -d "$name" ip netns exec exit python3 /repo/lab/udp/echo.py exit 198.51.100.10 65000
docker exec -d "$name" ip netns exec direct python3 /repo/lab/udp/echo.py direct 192.0.2.10 5060
docker exec -d "$name" ip netns exec direct python3 /repo/lab/udp/echo.py leak 198.51.100.10 5060
docker exec -d "$name" ip netns exec underlay python3 /repo/lab/udp/echo.py leak 198.51.100.10 5060
sleep 1

docker exec "$name" ip netns exec source ip rule del priority 110
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5060 blocked
docker exec "$name" ip netns exec source ip rule add fwmark 21077 lookup 5255 priority 110
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5060 exit:probe
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 10000 exit:probe
docker exec "$name" ip netns exec egress ip rule del to 10.42.0.0/24 priority 500
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5060 blocked
docker exec "$name" ip netns exec egress ip rule add to 10.42.0.0/24 lookup main priority 500
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 192.0.2.10 5060 direct:probe
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.3 198.51.100.10 5060 blocked
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5061 blocked

docker exec "$name" ip netns exec egress ip link set tailscale0 down
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5060 blocked
docker exec "$name" ip netns exec source ip rule del priority 110
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 5060 blocked
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 192.0.2.10 5060 direct:probe

# Replace only the disposable project tables for the all-client/all-port mode.
# A live nft -c checks interval elements against the old table and rejects a
# widening /32 -> /24. The lifecycle checks the candidate in an empty netns.
if node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$repo_dir/examples/config.regional-udp.yaml" |
  docker exec -i "$name" ip netns exec source nft -c -f - >/dev/null 2>&1; then
  echo 'udp_lab=FAIL: expected active-table collision was not reproduced' >&2
  exit 1
fi
node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$repo_dir/examples/config.regional-udp.yaml" |
  docker exec -i "$name" unshare --net nft -c -f -
docker exec "$name" ip netns exec source ip rule add fwmark 21077 lookup 5255 priority 110
docker exec "$name" ip netns exec egress ip link set tailscale0 up
docker exec "$name" ip netns exec egress ip route replace table 52 default via 100.64.0.1 dev tailscale0
docker exec "$name" ip netns exec source nft delete table inet vpn_router
docker exec "$name" ip netns exec egress nft delete table inet vpn_router_udp
node "$repo_dir/bin/vpn-router.mjs" render-nftables --config "$repo_dir/examples/config.regional-udp.yaml" |
  docker exec -i "$name" ip netns exec source nft -f -
node "$repo_dir/bin/vpn-router.mjs" render-udp-egress --config "$repo_dir/examples/config.regional-udp.yaml" |
  docker exec -i "$name" ip netns exec egress nft -f -
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 198.51.100.10 443 exit:probe
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.3 198.51.100.10 5061 exit:probe
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.3 198.51.100.10 65000 exit:probe
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 192.0.2.10 5060 direct:probe
docker exec "$name" ip netns exec egress ip link set tailscale0 down
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.3 198.51.100.10 65000 blocked
docker exec "$name" ip netns exec client python3 /repo/lab/udp/probe.py 10.42.0.2 192.0.2.10 5060 direct:probe

echo 'udp_lab=PASS'
