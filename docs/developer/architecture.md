# Architecture

## Data path

```text
tunnel interfaces (host or container) --- PREROUTING --\
                                                       +-> managed DNS/IP sets
proxy containers -------------------------- OUTPUT ---/          |
                                                                 +-> sing-box -> strict egress
unselected traffic --------------------------------------------------------> existing direct path
```

The core has no country-specific behavior. A routing profile is ordinary user
data containing domain suffixes and optional IPv4 CIDRs.

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

dnsmasq redirects plain DNS and inserts selected IPv4 answers into a
pre-created nftables set before returning the answer. Static CIDRs use a
separate set. The entries remain until disable or a fresh apply, preferring
temporary over-routing to a later direct leak from a longer-lived client cache.

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

`disable` is the master switch. It removes only the manifest-owned nftables
tables, capture/DNS/egress containers, project networks, and attachments. It
preserves source VPNs and Tailscale state. `reconcile` detects source-container
recreation and restores owned resources only after safe cleanup.

## Protocol boundary

Version `0.5.0-pre-alpha` is IPv4/TCP-only. Proxy namespaces reject IPv6;
tunnel preflight refuses a global IPv6 address because a safe client-scoped
IPv6 model is not implemented. DoH/DoT, ECH, direct-IP connections, private
resolvers, and shared CDN addresses remain explicit limitations.

## Upstream references

- [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)
- [Tailscale coexistence with other VPNs](https://tailscale.com/docs/reference/faq/other-vpns)
- [sing-box dial fields and routing mark](https://sing-box.sagernet.org/configuration/shared/dial/)
- [sing-box redirect inbound](https://sing-box.sagernet.org/configuration/inbound/redirect/)
- [dnsmasq nftset options](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
