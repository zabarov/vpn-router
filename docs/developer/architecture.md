# Architecture

## Adapter pipeline

```text
traffic source adapter -> capture driver -> policy and DNS engine -> egress adapter
```

The core evaluates policies independently from the source and egress
implementations. An adapter declares its capabilities, owned resources, health
signal, and recovery behavior.

## First supported topology

AmneziaWG 2 exposes `awg0` inside its Docker container. Its own NAT rules can
rewrite client traffic before it appears on the host. Therefore the router
sidecar must join the Amnezia container network namespace and observe traffic
before NAT; matching the original client subnet on the host is not sufficient.

```text
client -> awg0 (Amnezia namespace) -> router sidecar -> policy -> egress
```

The Tailscale adapter is an egress endpoint. A strict policy using that adapter
must fail at that outbound when the adapter is unhealthy; it must never become
direct traffic by accident. Domain policies are classified by TLS SNI or HTTP
host name inside the router, rather than relying only on a client's DNS path.

## Ownership model

Every deployment declares its own nftables table, routing mark and mask, route
table, rule priority, service name, and state directory. The implementation
must modify only those declared resources and must have a matching rollback
operation.

## Protocol policy

The early strict profile rejects unproven UDP/QUIC and IPv6 paths. This is not
a permanent limitation: each path becomes available only after a disposable
test proves correct routing, DNS behavior, and failure handling.
