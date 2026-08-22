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
