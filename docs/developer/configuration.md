# Configuration reference

The router reads YAML configuration conforming to
[`schema/config.schema.json`](../../schema/config.schema.json). The local
validator checks structural and safety invariants; it does not make system
changes.

## Required sections

- `schema_version`: currently `1.0`.
- `sources`: named VPN traffic sources.
- `capture`: the transparent capture driver and its listener port.
- `egresses`: named direct or Tailscale egress adapters.
- `policies`: named route decisions.
- `destination_sets`: named IPv4/IPv6 CIDR sets referenced by non-default policies.
- `traffic_handling`: explicit behavior for UDP/QUIC and IPv6.
- `resources`: deployment-owned routing and state resources.

## Policy failure modes

`failure_mode: block` is for traffic that must not leave through the direct
path. `failure_mode: direct` is an explicit opt-in for a non-strict policy.
There is no implicit fallback.

## Secrets

Use an environment-variable name such as `VPN_ROUTER_TAILSCALE_AUTH_KEY`; do
not put its value in YAML. The example configuration contains only names and
non-routable documentation placeholders.

## AmneziaWG 2 source

An `amneziawg2_container` source requires the Docker container name, the
interface name (`awg0` for the first verified topology), and the client CIDR.
The eventual runtime places the capture component in that container network
namespace.

## Capture and destinations

The initial runtime uses Linux TPROXY. `capture.listen_port` is the port that
the owned nftables rules deliver to the router. It must not collide with a
port already used inside the Amnezia container namespace.

`destination_sets` currently use CIDRs only. Domain-driven routing needs a
separate DNS evidence and leak-test milestone, so it is not silently enabled
by the first deployment.
