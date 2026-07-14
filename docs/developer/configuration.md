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
- `destination_sets`: named IPv4/IPv6 CIDR and/or domain-suffix sets referenced by non-default policies.
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

## Tailscale SOCKS egress

A `tailscale_socks` egress has two separate responsibilities:

- `proxy_server` and `proxy_port` identify the isolated SOCKS5 service that
  the router connects to.
- `auth_key_env` and `exit_node` are deployment inputs for that isolated
  Tailscale service. They are not included in the generated sing-box file.

`exit_node` must be a Tailscale IP address or a resolvable full hostname;
short machine labels are not sufficient. The Tailscale container must keep its
own network namespace. Do not run it with `network_mode:
container:<amnezia-container>`.

## AmneziaWG 2 source

An `amneziawg2_container` source requires the Docker container name, the
interface name (`awg0` for the first verified topology), and the client CIDR.
The eventual runtime places the capture component in that container network
namespace.

## Capture and destinations

The initial runtime uses Linux TPROXY. `capture.listen_port` is the port that
the owned nftables rules deliver to the router. It must not collide with a
port already used inside the Amnezia container namespace.

Domain suffixes use lower-case ASCII, with IDN domains written as punycode. For
example, the Russian suffix `.рф` is `.xn--p1ai`. A strict domain set is
realized by dnsmasq: it observes client DNS, adds resolved IPv4 addresses to
the router's owned nftables set, and only then allows the capture rule to send
that traffic to the selected egress. This keeps non-selected TCP traffic out
of the sidecar.

With `dns_mode: managed`, the generated nftables policy redirects client DNS
on the source interface to dnsmasq port 5353. Encrypted DNS and direct-IP
connections do not carry a domain suffix and are therefore not classified by
this first adapter. QUIC is rejected in strict profiles so that a browser can
retry via TCP/TLS, where DNS-derived classification is enforceable.
