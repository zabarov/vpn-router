# Configuration reference

The installed `vpn-router configure` wizard produces this schema interactively
or with explicit non-interactive flags. It validates before writing, uses mode
`0600`, refuses overwrite unless `--force` is provided, and never asks for or
stores a credential value.

The YAML contract is published as
[`schema/config.schema.json`](../../schema/config.schema.json). The custom
validator adds semantic safety rules that JSON Schema cannot express compactly.

For the common managed topology, `vpn-router discover` reads the running Docker
source without changing it, and `vpn-router configure --preset
amnezia-tailscale` fills the detected container, interface, subnet, and one
real canary `/32`. Ambiguous discovery fails closed and requires explicit
source flags. The preset never writes an auth key.

## Pre-alpha shape

The current pre-alpha contract requires:

- exactly one active source;
- exactly one direct and one supported strict egress, both referenced;
- exactly one strict policy with `failure_mode: block`;
- exactly one default policy with `destination_sets: [default]`, a direct
  egress, and `failure_mode: direct`;
- the same source in both policies;
- `traffic_handling.udp_quic: reject` and `traffic_handling.ipv6: reject`;
- managed DNS whenever the strict policy contains domain suffixes.

Non-default `failure_mode: direct`, multiple strict regions, IPv6 CIDRs, and
alternate protocol behavior are rejected instead of being
partially implemented.

## Sources

### `amneziawg2_container`

Use this when the VPN interface lives inside an Amnezia Docker container:

```yaml
sources:
  - tag: amnezia-in
    type: amneziawg2_container
    container_name: amnezia-awg2
    interface: awg0
    client_scope:
      mode: address_list
      addresses: [10.8.1.2/32]
```

`client_scope` is an enforcement boundary, not documentation. Use
`address_list` for a staged rollout and `mode: subnet` with the explicit VPN
CIDR for all users. `0.0.0.0/0` and interface-only wildcard selection are
rejected. The legacy `client_subnet` field accepts one `/32` during migration.

### `linux_interface`

Use this for WireGuard, OpenVPN, IPsec, or another VPN whose interface is in the
namespace where nftables and the capture process run:

```yaml
sources:
  - tag: generic-vpn
    type: linux_interface
    interface: wg0
    client_scope:
      mode: subnet
      subnet: 10.8.1.0/24
```

The bundled lifecycle runs the capture and DNS sidecars with host networking
for this adapter and applies its owned nftables table in the host namespace.
The VPN implementation remains operator-owned and is never restarted. Use an
external `socks5` egress or a different `linux_interface`; managed Tailscale
currently requires `amneziawg2_container`.

## Egresses

A `tailscale_socks` egress declares the isolated userspace service:

```yaml
egresses:
  - tag: strict-egress
    type: tailscale_socks
    auth_key_env: VPN_ROUTER_TAILSCALE_AUTH_KEY
    exit_node: exit-node.example.ts.net
    proxy_server: vpn-router-egress
    proxy_port: 1055
    healthcheck_url: https://example.com/
```

The YAML contains only the environment-variable name, never the auth-key
value. For the managed Amnezia lifecycle, `proxy_server` must be
`<resources.service_name>-egress`. `exit_node` must be a full hostname or IP,
not an ambiguous short label.
`healthcheck_url` must be a credential-free HTTPS URL that is expected to be
reachable through the selected exit. Managed apply does not report success
until this URL works through the actual SOCKS listener three consecutive times.
The generated sing-box configuration uses Docker's local resolver without an
internal DNS cache so the SOCKS service name can recover after a container
restart instead of retaining a transient negative answer.

An external SOCKS5 server is provider-neutral:

```yaml
egresses:
  - tag: remote-exit
    type: socks5
    server: egress.example.net
    port: 1080
    healthcheck_url: https://example.com/
```

The first contract supports a credential-free SOCKS5 endpoint. Protect it with
network allowlists or a separately managed tunnel; authenticated SOCKS secrets
are not yet accepted in public YAML.

A separately managed local tunnel can be selected by interface:

```yaml
egresses:
  - tag: tunnel-exit
    type: linux_interface
    interface: wg-exit
    healthcheck_url: https://example.com/
```

The generators support all three adapters. With an `amneziawg2_container`
source, the bundled transactional lifecycle manages the Tailscale sidecar and
treats SOCKS5 services or tunnel interfaces as external dependencies. It
health-checks external dependencies but never starts, stops, or reconfigures
them.

## Destination sets

Sets may contain IPv4 CIDRs, lower-case ASCII domain suffixes, or both:

```yaml
destination_sets:
  selected-services:
    domain_suffixes:
      - .service.example
      - .corp.example
    ip_cidrs:
      - 192.0.2.0/24
```

Use punycode for internationalized names. The committed suffixes are reserved
documentation examples, not a maintained destination list or geographic
database. An IP learned for one selected hostname can also serve unrelated
names on a shared CDN, so strict profiles need acceptance testing.

## Managed DNS limitations

The generated rules redirect plain client DNS on TCP/UDP port 53 to dnsmasq
port 5353 for the configured client scope. dnsmasq populates the owned IPv4 nftables
set before returning the answer. DNS TTL and dnsmasq cache lifetime are capped
at 300 seconds. Dynamic nftables entries remain until `disable`, rollback, or a
fresh apply. This prevents a longer-lived client DNS cache from creating a
direct-routing gap after an nftables timeout.

DoH, DoT, browser Secure DNS, ECH, direct-IP connections, applications with a
private resolver, and cached addresses learned before apply bypass suffix
observation. Guaranteed strict mode therefore requires system DNS and an empty
client DNS cache at canary start. They are documented limitations, not silent
fallbacks.

## Owned resources

`resources` declares one nftables table and a service-name prefix. Values must
not collide with an existing deployment. The redirect runtime deliberately
does not install policy rules, packet marks, or route tables. The lifecycle
refuses an unowned collision and stores its root-only manifest under
`/var/lib/<service_name>/runtime/`.
