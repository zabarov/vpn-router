# AmneziaWG 2 sidecar deployment model

## Why the router joins the container namespace

The verified AmneziaWG 2 layout keeps `awg0` and VPN client addresses inside
the Amnezia Docker container. NAT then changes those source addresses before
the host can inspect them. A host-only router therefore cannot reliably apply
client-subnet policy.

The VPN Router runtime must join the existing Amnezia container network
namespace. The sidecar observes traffic on `awg0`, applies its owned policy
resources, and sends selected traffic to its configured egress adapter.

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
