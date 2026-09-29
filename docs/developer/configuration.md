# Configuration reference

`vpn-router configure` writes validated mode-`0600` YAML and refuses to
overwrite a file unless `--force` is explicit. The published JSON Schema is
[`schema/config.schema.json`](../../schema/config.schema.json); the semantic
validator enforces additional safety relationships.

## Schema version 3

A configuration contains one or more sources, exactly one strict egress plus
one direct egress, one strict policy, an optional higher-priority direct
override, and one default-direct policy. All policies cover the same source set.

```yaml
schema_version: "3.0"
routing_data:
  country_provider:
    type: ripestat
    refresh_interval: 24h
    max_stale: 7d
  domain_resolver:
    refresh_interval: 5m
    min_ttl: 60
    max_ttl: 3600
    max_stale: 24h
sources:
  - tag: tunnel-in
    type: tunnel_interface
    namespace: container
    container_name: amnezia-awg2
    interface: awg0
    clients:
      mode: subnet
      subnet: 10.8.1.0/24
  - tag: proxy-in
    type: container_egress
    container_name: amnezia-xray
    clients:
      mode: all
```

The complete safe shape is in [`config.example.yaml`](../../config.example.yaml).

## Sources

### `tunnel_interface`

Use `namespace: host` for a host WireGuard/OpenVPN/TUN interface. Use
`namespace: container` plus `container_name` when the interface is inside an
Amnezia or other VPN container.

`clients` is an enforcement boundary:

```yaml
clients:
  mode: address_list
  addresses: [10.8.1.2/32]
```

Use `address_list` for a canary. After acceptance, use `mode: subnet` with the
canonical VPN CIDR. Wildcard `0.0.0.0/0` scope is rejected.

### `container_egress`

Use this when a proxy such as XRay terminates client sessions and creates new
outbound sockets:

```yaml
- tag: xray-in
  type: container_egress
  container_name: amnezia-xray
  clients:
    mode: all
```

Only `mode: all` is valid. Outbound sockets no longer contain the original VPN
client address, so per-user selection would be misleading and unsafe.

## Egress adapters

Managed Tailscale userspace SOCKS:

```yaml
- tag: strict-egress
  type: tailscale_socks
  auth_key_env: VPN_ROUTER_TAILSCALE_AUTH_KEY
  exit_node: exit-node.example.ts.net
  proxy_server: vpn-router-egress
  proxy_port: 1055
  healthcheck_url: https://example.com/
```

The YAML stores only an environment variable name. A one-off key is needed for
first enrollment and is removed from the recreated egress container after its
state has been persisted.

External credential-free SOCKS5:

```yaml
- tag: strict-egress
  type: socks5
  server: proxy.example.net
  port: 1080
  healthcheck_url: https://example.com/
```

Externally managed Linux interface:

```yaml
- tag: strict-egress
  type: linux_interface
  interface: wg-exit
  healthcheck_url: https://example.com/
```

External adapters are health-checked but never started, stopped, or configured
by VPN Router.

## Policies and destination sets

Policies are evaluated top to bottom: `always-direct`, strict routing, then
default direct. The strict policy uses `failure_mode: block`; it never falls
back directly. All policies must cover the same sources.

Country codes are upper-case ISO alpha-2 values. Country prefixes come from
RIPEstat's Country Resource List and describe registry association rather than
guaranteed physical location. Exact domains are resolved by the server and
refreshed without client DNS. Domain suffixes must be lower-case ASCII with a
leading dot; use punycode for internationalized names.

```yaml
destination_sets:
  regional:
    country_codes: [RU]
    exact_domains: [obr.site, 2ip.io]
    domain_suffixes: [.ru, .xn--p1ai, .su]
    ip_cidrs: []
  direct-overrides:
    exact_domains: []
    ip_cidrs: [198.51.100.0/24]
```

## Managed DNS limitations

Plain TCP/UDP port 53 is redirected to dnsmasq for suffix observation. DoH,
DoT, browser Secure DNS, private resolvers, and ECH can bypass that observation.
They do not bypass country CIDRs, static CIDRs, or already resolved exact-domain
addresses. Shared CDN addresses can cause another hostname on the same IP to
follow the same route.

## Migration

Schema versions 1 and 2 remain readable. Create a separate version-3 file without
changing the original:

```sh
vpn-router migrate-config --input old.yaml --output new.yaml
```

The migration maps `amneziawg2_container` and `linux_interface` sources to the
new `tunnel_interface` adapter and changes policy `source` fields to `sources`
arrays.

## Experimental UDP telephony canary

The optional `traffic_handling.udp_routing` contract is for one containerized
`tunnel_interface` source and the managed Tailscale egress only. It is not
available for XRay/container-egress, an external SOCKS5 server, or a generic
Linux interface. The default setup wizard does not enable it. The advanced
`setup` command accepts `--udp-source-container`, exactly one of
`--udp-client-addresses` or `--udp-client-subnet`, and
`--udp-destination-ports`. Optional `--udp-destination-cidrs` adds a separate
strict provider set; without it, UDP uses the existing strict destination
sets. The source's `udp_clients` must be inside its normal `clients` scope;
begin with one `/32` before selecting the VPN subnet.

```yaml
sources:
  - tag: vpn-in
    type: tunnel_interface
    namespace: container
    container_name: example-vpn
    interface: wg0
    clients:
      mode: subnet
      subnet: 10.42.0.0/24
    udp_clients:
      mode: address_list
      addresses: [10.42.0.2/32]
traffic_handling:
  udp_quic: reject
  ipv6: reject
  dns_mode: managed
  udp_routing:
    mode: tailscale_tun
    source: vpn-in
    destination_sets: [voice-provider]
    destination_ports: ["5060", "3478", "10000-50000"]
```

`voice-provider` must be part of the strict policy. Its `ip_cidrs` must come
from the provider's current published signaling and media ranges. SIP proxy
addresses alone do not prove that RTP media uses the same IPs; check the
provider documentation and a real call. UDP/443 remains rejected to prevent
QUIC bypass in this narrow mode. The separate `[all]` destination-port mode
requires `udp_quic: route` and sends every UDP port, including QUIC, only to
the selected destinations. The managed Tailscale container uses a TUN
interface in this mode
while retaining its SOCKS listener for TCP, so switching an existing runtime
requires an outage-aware disable and re-enable. See the
[canary procedure](../operations/udp-telephony-canary.md) and
[generic example](../../examples/config.sip-udp.yaml). For the subnet/all-port
variant, see the [regional UDP guide](../operations/regional-udp.md) and
[example](../../examples/config.regional-udp.yaml).
