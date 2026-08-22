# Architecture

## Data path

```text
tunnel interfaces (host or container) --- PREROUTING --\
                                                       +-> managed DNS/IP sets
proxy containers -------------------------- OUTPUT ---/          |
                                                                 +-> sing-box -> strict egress
unselected traffic --------------------------------------------------------> existing direct path
```

The core has no hard-coded country behavior. A routing profile contains ISO
country codes, exact domains, suffixes, and optional IPv4 CIDRs. RIPEstat
country resources and server DNS answers are normalized into root-only,
integrity-checked last-known-good state.

## Source adapters

`tunnel_interface` captures packets before the existing VPN source performs
NAT. Rules match the declared interface and an explicit `/32` list or VPN
subnet. The interface may live on the host or inside a container.

`container_egress` captures outbound sockets in one proxy container namespace.
This is the adapter for XRay/V2Ray-style protocols that terminate connections
inside a container. It necessarily applies to every user of that container;
per-user identity is no longer present on outbound packets.

VPN Router borrows source namespaces. It never owns, edits, stops, removes, or
restarts source VPN containers.

## Namespace services

Each distinct source namespace receives:

- one project-owned nftables table;
- one managed DNS sidecar when suffix selection is used;
- one sing-box capture sidecar.

All namespaces share one strict egress. For managed Tailscale, the egress is a
userspace-networking container with persistent state. Container sources are
connected to a project-owned internal proxy network using negative gateway
priority, so their default routes do not change. A host source reaches the same
SOCKS listener through a loopback-only published port.

## Selection and loop prevention

Country CIDRs, exact-domain addresses, static CIDRs, and DNS-observed suffix
addresses use separate nftables sets. A timer refreshes server data and swaps
dynamic set contents atomically. Failed or suspicious refreshes preserve fresh
last-known-good data. dnsmasq inserts plain-DNS suffix answers before returning
the answer.

Tunnel sources use nftables `PREROUTING`. Proxy sources use `OUTPUT` and exclude:

- dnsmasq by its dedicated UID;
- sing-box connections by an explicit routing mark;
- loopback destinations after DNS redirection.

sing-box routes everything accepted by its strict inbound directly to the
selected egress. It does not repeat SNI classification.

## Fail-closed behavior

Selected TCP is redirected locally. A tunnel `FORWARD` guard rejects a packet
that was selected but not claimed by redirect. A proxy `OUTPUT` guard rejects
selected TCP that was not claimed. Selected UDP, including QUIC, is rejected.
If sing-box or SOCKS is unavailable, the selected connection fails locally;
unselected traffic never enters the capture process.

## Lifecycle and ownership

`enable` validates every namespace, captures a root-only network baseline,
stores exact source container IDs, arms a systemd rollback deadman, and applies
all sources transactionally. Failure in one source rolls back the whole apply.

`disable` is the master switch. It stops data updates and removes only the manifest-owned nftables
tables, capture/DNS/egress containers, project networks, and attachments. It
preserves source VPNs and Tailscale state. Each container namespace has a
recorded kernel identity in addition to its Docker ID. `reconcile` detects a
stop/start or recreation even when Docker keeps the same ID, then replaces only
the affected owned sidecars while the nftables guard remains fail-closed. When
the source itself has a new namespace, its root-only clean source baseline is
refreshed before project resources are attached; the superseded baseline is
archived as recovery evidence. The optional watchdog invokes this path
periodically but never re-enables a disabled manifest.

## Protocol boundary

Version `0.6.0-alpha.1` is IPv4/TCP-only. Proxy namespaces reject IPv6;
tunnel preflight refuses a global IPv6 address because a safe client-scoped
IPv6 model is not implemented. DoH/DoT and ECH remain limitations for arbitrary
suffix observation, but do not bypass country/static CIDRs or already resolved
exact domains. Shared CDN addresses remain an explicit over-routing limitation.

## Upstream references

- [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)
- [Tailscale coexistence with other VPNs](https://tailscale.com/docs/reference/faq/other-vpns)
- [sing-box dial fields and routing mark](https://sing-box.sagernet.org/configuration/shared/dial/)
- [sing-box redirect inbound](https://sing-box.sagernet.org/configuration/inbound/redirect/)
- [dnsmasq nftset options](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
- [RIPEstat Country Resource List](https://stat.ripe.net/docs/data-api/api-endpoints/country-resource-list)
