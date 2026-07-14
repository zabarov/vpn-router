# TPROXY fail-closed lab

This disposable lab proves two runtime properties in a Docker-only network:

1. A TCP packet from a virtual Amnezia client enters `awg0`, is intercepted by
   nftables TPROXY, and reaches a target only through the running sidecar.
2. After the sidecar stops, the same strict destination cannot reach the
   target directly.

Run and clean up:

```sh
./lab/tproxy/verify.sh
docker compose -f lab/tproxy/compose.yaml down --volumes
```

The lab uses a direct outbound as a stand-in for a healthy egress adapter.
It does not prove Tailnet enrollment or a real exit node; those remain a
separate live prerequisite.
