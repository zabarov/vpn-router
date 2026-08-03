# Architecture

## Policy pipeline

```text
source adapter -> managed DNS/IP selection -> source-scoped capture -> strict egress
                                      \---- non-selected traffic ----> direct egress
```

The core has no country-specific behavior. A regional profile is ordinary user
data: domain suffixes and optional IPv4 CIDRs. Source and egress implementations
remain adapters.

## AmneziaWG2 topology

AmneziaWG2 keeps `awg0`, client addresses, and pre-NAT traffic inside its Docker
network namespace. The capture and DNS sidecars therefore join that namespace.
The existing Amnezia container is connected to one project-owned internal
network with a negative gateway priority; this adds SOCKS reachability without
changing its default route.

```text
Amnezia namespace
  canary /32 -> awg0
    |-- DNS :53 -> dnsmasq :5353 -> nftables DNS set (10 minute timeout)
    |-- selected TCP -> nftables REDIRECT -> sing-box
    |-- selected UDP / UDP 443 -> reject
    `-- everything else -> existing Amnezia NAT/direct path

sing-box -> project internal proxy network -> Tailscale userspace container
                                             -> separate control network
                                             -> selected exit node
```

Tailscale never joins the Amnezia namespace and cannot replace its default
route. Its SOCKS listener is not published on the host.

sing-box resolves the project-owned SOCKS service through the container's local
resolver with its own DNS cache disabled. A temporary `NXDOMAIN` while the
Tailscale container is stopped is therefore not retained after that container
returns; recovery does not require restarting the capture sidecar.

## Selection and fail-closed behavior

dnsmasq adds only IPv4 answers for configured suffixes to a timeout-enabled
nftables set. DNS replies and the dnsmasq cache are capped at 300 seconds. The
nftables set retains addresses for ten minutes. The extra five-minute overlap
prevents a cached DNS reply near expiry from outliving its strict-routing
entry. Static CIDRs use a separate non-expiring set.

Every generated DNS redirect, TCP redirect, forward guard, UDP, and QUIC rule
matches both the source interface and `source.client_subnet`. The pre-alpha
validator requires that subnet to be one `/32`.

For every selected TCP set, the generator emits two complementary rules:

1. A NAT-prerouting TCP redirect to the sing-box redirect listener.
2. A forward-hook reject for the same interface, source, and destination.

Redirected traffic is locally delivered and never reaches the forward hook. If
the listener disappears, the redirected connection is closed locally. If the
redirect does not claim a selected packet, the forward guard blocks it before
the ordinary NAT path. If SOCKS disappears while sing-box is running, sing-box
has only the strict outbound and no direct fallback. Non-selected traffic never
enters sing-box.

The router does not sniff TLS or HTTP names after DNS/IP selection. Repeating
classification inside the capture process would turn unknown captured traffic
into an accidental block or fallback decision.

## Protocol boundary

Version `0.2.0-pre-alpha` supports IPv4/TCP only. Selected UDP is rejected and
UDP/443 is rejected for the canary so clients can retry over TCP. A global IPv6
address on the source interface makes managed preflight fail. IPv6 requires a
future source identity and routing design that can preserve the `/32` isolation
guarantee; an interface-wide IPv6 reject would affect unrelated clients.

## Ownership and recovery

One deployment owns exactly the names derived from `resources.service_name`
plus its declared nftables table. Before any apply, the lifecycle captures
root-only Docker, address, route, rule, and nftables evidence. It refuses a
name or table collision without an existing project manifest.

`apply` is transactional and arms a systemd rollback deadman. `rollback`
removes only manifest-owned sidecars, networks, and table. It does not modify
the AmneziaWG2 container, its routes, or the persisted Tailscale state.

## Upstream references

- [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking)
- [Tailscale coexistence with other VPNs](https://tailscale.com/docs/reference/faq/other-vpns)
- [sing-box redirect inbound](https://sing-box.sagernet.org/configuration/inbound/redirect/)
- [dnsmasq nftset and cache options](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
