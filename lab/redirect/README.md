# TCP redirect fail-closed lab

This disposable lab proves the critical IPv4/TCP runtime properties in a
Docker-only network:

The verification script renders nftables, dnsmasq, and sing-box artifacts from
`config.yaml` with the public generators before starting the topology. Only the
lab's ordinary direct-path NAT lives in a separate handwritten nftables table.

1. A TCP packet from a virtual Amnezia client enters `awg0`, is intercepted by
   an nftables TCP redirect, and reaches a target only through the running
   sidecar.
2. After the sidecar stops, the same strict destination cannot reach the
   target directly.
3. A different target IP remains direct before and after either strict-path
   sidecar stops.
4. A second client outside the configured `/32` remains completely unaffected.
5. The strict path depends on a separate SOCKS service, which stands in for the
   isolated Tailscale userspace egress.
6. A managed DNS response inserts the selected address before the first client
   connection, and a stopped SOCKS egress makes that first connection fail
   closed instead of leaking direct.
7. Selected DNS-set entries persist after managed DNS stops and all lab
   containers, networks and volumes are removed automatically.
8. A transient negative Docker-DNS answer while the SOCKS service is stopped is
   not cached: the same sing-box process recovers after the service starts.

Run and clean up:

```sh
./lab/redirect/verify.sh
```

The SOCKS service uses a direct outbound as a stand-in for a healthy Tailscale
exit adapter. Stopping it proves that sing-box does not fall back to direct.
The lab does not prove Tailnet enrollment or a real exit node; those remain a
separate gated runtime check.
