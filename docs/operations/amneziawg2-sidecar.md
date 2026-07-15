# AmneziaWG 2 sidecar deployment model

## Why the router joins the container namespace

The reference AmneziaWG 2 layout keeps `awg0` and VPN client addresses inside
the Amnezia Docker container. NAT then changes those source addresses before
the host can inspect them. A host-only router therefore cannot reliably apply
client-subnet policy.

The capture and DNS sidecars join the existing Amnezia container network
namespace. The Tailscale exit sidecar deliberately does not: it joins the same
Docker network as Amnezia but keeps its own network namespace and exposes a
userspace SOCKS5 listener. The router sends only selected traffic to that
listener. This separation prevents an exit-node route from replacing the
Amnezia namespace default route.

## Read-only preflight

Run this before preparing any deployment. It does not change Docker, firewall,
routes, DNS, or the VPN container:

```sh
./scripts/preflight-amneziawg2.sh --container amnezia-awg2
```

The command confirms that the named container is running and that `awg0`
exists with an IPv4 address inside that namespace. A different container or
interface name is supported explicitly:

```sh
./scripts/preflight-amneziawg2.sh --container <name> --interface <name>
```

## Lifecycle requirement

`network_mode: container:<name>` binds the sidecar to the current target
container namespace. If the Amnezia container is recreated, the sidecar must
be restarted against the new namespace. A production deployment therefore
needs an independent supervisor and a health check that fails if the source
container or `awg0` disappears.

## Deployment gate

Do not deploy merely because this preflight passes. The operator still needs a
Tailscale enrollment method, selected exit node, resource ownership map,
backup, rollback, change window, and end-to-end smoke plan. See
[the live validation gate](live-validation.md).

## Current validation status

The namespace layout and isolated Tailscale SOCKS egress have been observed on
a real AmneziaWG 2 host. Client acceptance of the TPROXY capture path is not
yet proven: a live experiment interrupted VPN-client connectivity and was
fully rolled back. Reproduce the packet path in a disposable namespace lab and
prove client connectivity before treating this adapter as deployable.
