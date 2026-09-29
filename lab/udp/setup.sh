#!/bin/sh
set -eu

for name in client source egress exit direct underlay proxy; do ip netns add "$name"; ip netns exec "$name" ip link set lo up; done

ip link add wg0 type veth peer name client0
ip link set wg0 netns source
ip link set client0 netns client
ip netns exec source ip addr add 10.42.0.1/24 dev wg0
ip netns exec client ip addr add 10.42.0.2/24 dev client0
ip netns exec client ip addr add 10.42.0.3/24 dev client0
ip netns exec source ip link set wg0 up
ip netns exec client ip link set client0 up
ip netns exec client ip route add default via 10.42.0.1

ip link add vrudp0 type veth peer name vrudp1
ip link set vrudp0 netns source
ip link set vrudp1 netns egress
ip netns exec source ip addr add 169.254.253.0/31 dev vrudp0
ip netns exec egress ip addr add 169.254.253.1/31 dev vrudp1
ip netns exec source ip link set vrudp0 up
ip netns exec egress ip link set vrudp1 up
ip netns exec source ip route add table 5255 default via 169.254.253.1 dev vrudp0
ip netns exec source ip rule add fwmark 21077 lookup 5255 priority 110
ip netns exec egress ip route add 10.42.0.2/32 via 169.254.253.0 dev vrudp1
ip netns exec egress ip rule add to 10.42.0.2/32 lookup main priority 500

ip link add eg-proxy type veth peer name proxy0
ip link set eg-proxy netns egress
ip link set proxy0 netns proxy
ip netns exec egress ip addr add 172.19.0.2/24 dev eg-proxy
ip netns exec proxy ip addr add 172.19.0.3/24 dev proxy0
ip netns exec egress ip link set eg-proxy up
ip netns exec proxy ip link set proxy0 up
ip netns exec egress ip rule add to 172.19.0.0/24 lookup main priority 490

ip link add src-direct type veth peer name direct0
ip link set src-direct netns source
ip link set direct0 netns direct
ip netns exec source ip addr add 192.0.2.2/30 dev src-direct
ip netns exec direct ip addr add 192.0.2.1/30 dev direct0
ip netns exec source ip link set src-direct up
ip netns exec direct ip link set direct0 up
ip netns exec source ip route add default via 192.0.2.1
ip netns exec direct ip addr add 198.51.100.10/32 dev lo
ip netns exec direct ip addr add 192.0.2.10/32 dev lo
ip netns exec direct ip route add 10.42.0.0/24 via 192.0.2.2

ip link add tailscale0 type veth peer name exit0
ip link set tailscale0 netns egress
ip link set exit0 netns exit
ip netns exec egress ip addr add 100.64.0.2/30 dev tailscale0
ip netns exec exit ip addr add 100.64.0.1/30 dev exit0
ip netns exec egress ip link set tailscale0 up
ip netns exec exit ip link set exit0 up
ip netns exec exit ip addr add 198.51.100.10/32 dev lo
ip netns exec egress ip route add 198.51.100.0/24 via 100.64.0.1 dev tailscale0
ip netns exec egress ip route add table 52 default via 100.64.0.1 dev tailscale0
ip netns exec egress ip rule add priority 5210 lookup 52

ip link add eg-underlay type veth peer name underlay0
ip link set eg-underlay netns egress
ip link set underlay0 netns underlay
ip netns exec egress ip addr add 172.18.0.2/30 dev eg-underlay
ip netns exec underlay ip addr add 172.18.0.1/30 dev underlay0
ip netns exec egress ip link set eg-underlay up
ip netns exec underlay ip link set underlay0 up
ip netns exec underlay ip addr add 198.51.100.10/32 dev lo
ip netns exec egress ip route add default via 172.18.0.1
ip netns exec underlay ip route add 10.42.0.0/24 via 172.18.0.2

ip netns exec source sysctl -q -w net.ipv4.ip_forward=1
ip netns exec egress sysctl -q -w net.ipv4.ip_forward=1
ip netns exec direct sysctl -q -w net.ipv4.ip_forward=1
ip netns exec underlay sysctl -q -w net.ipv4.ip_forward=1
