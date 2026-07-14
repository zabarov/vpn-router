# Disposable namespace lab

This lab proves one narrow architectural invariant: a sidecar launched with
`network_mode: service:source` shares the source container's network namespace
and captures an original client source address on `awg0` there.

It creates a virtual `awg0` and an isolated client namespace only inside a
disposable Alpine container. The client at `10.8.1.2` opens a local TCP probe
to `10.8.1.1:18080`; the sidecar captures that packet on `awg0`.
It does not install VPN software, configure Tailscale, alter the host firewall,
or send traffic through an exit node.

The `source` lab container is privileged only so it can create a nested client
network namespace and virtual Ethernet pair. Do not use this lab privilege
model as a production deployment template.

Run it on a Docker host:

```sh
./lab/verify.sh
docker compose -f lab/compose.yaml down --volumes
```

Expected result:

```text
PASS: sidecar captured 10.8.1.2 traffic on awg0 before NAT.
```

This proves the pre-NAT capture boundary, but it does not yet prove TPROXY
interception, DNS policy, selected egress, or fail-closed behavior.

## Tailscale configuration syntax check

The repository also ships a no-credential Tailscale endpoint fixture. Validate
it against the pinned sing-box version without joining a Tailnet:

```sh
docker run --rm \
  -v "$PWD/lab/sing-box-tailscale-check.json:/config.json:ro" \
  ghcr.io/sagernet/sing-box:v1.13.12 check -c /config.json
```

This verifies configuration syntax only. A real exit-node test needs a
user-owned Tailnet node and an enrollment method.

## TPROXY fail-closed proof

[The TPROXY lab](tproxy/README.md) routes a packet through a running sidecar,
then stops that sidecar and verifies that the strict destination does not leak
through the direct path.
