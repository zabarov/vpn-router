# Configuration reference

`vpn-router configure` writes validated mode-`0600` YAML and refuses to
overwrite a file unless `--force` is explicit. The published JSON Schema is
[`schema/config.schema.json`](../../schema/config.schema.json); the semantic
validator enforces additional safety relationships.

## Schema version 2

A configuration contains one or more sources, exactly one strict egress plus
one direct egress, one strict policy, and one default-direct policy. Both
policies must cover the same source set.

```yaml
schema_version: "2.0"
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

The strict policy uses `failure_mode: block`; the default policy uses the
direct egress. `sources` may list all or an explicit subset, but the current
MVP requires the strict and default policies to cover the same set.

Domain suffixes must be lower-case ASCII with a leading dot. Use punycode for
internationalized domains. Optional IPv4 CIDRs may be combined with suffixes.
No country or provider list is built in.

```yaml
destination_sets:
  selected-services:
    domain_suffixes: [.service.example, .corp.example]
    ip_cidrs: [192.0.2.0/24]
```

## Managed DNS limitations

Plain TCP/UDP port 53 is redirected to dnsmasq. DoH, DoT, browser Secure DNS,
private resolvers, ECH, direct-IP connections, and addresses cached before
enable can bypass suffix observation. Shared CDN addresses can cause another
hostname on the same IP to follow the strict path. These cases require operator
testing and are not claimed as guaranteed.

## Migration

Schema version 1 remains readable. Create a separate version-2 file without
changing the original:

```sh
vpn-router migrate-config --input old.yaml --output new.yaml
```

The migration maps `amneziawg2_container` and `linux_interface` sources to the
new `tunnel_interface` adapter and changes policy `source` fields to `sources`
arrays.
