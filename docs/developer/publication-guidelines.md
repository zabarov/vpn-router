# Publication guidelines

These guidelines help maintainers and authors describe VPN Router accurately,
reproducibly, and within the project's [responsible-use](../../RESPONSIBLE_USE.md)
boundary. They are editorial guidance, not a jurisdiction-specific legal
opinion.

## Recommended framing

Describe VPN Router as a policy-based egress router for self-hosted or
operator-managed VPN infrastructure. The central engineering idea is:

```text
The VPN transports a packet to the router.
The routing policy selects the packet's authorized egress.
```

Useful publication topics include:

- separating a VPN tunnel from egress policy;
- source-scoped routing and staged rollout;
- managed DNS classification and its limitations;
- strict egress adapters and provider-neutral configuration;
- fail-closed behavior, isolation, rollback, and secret handling;
- testing services owned or administered by the operator from multiple
  authorized network locations;
- the project's pre-alpha limitations and remaining readiness gates.

## Reproducible examples

Public examples should use:

- `.example` names, such as `.service.example` and `.corp.example`;
- documentation address ranges such as `192.0.2.0/24`, `198.51.100.0/24`, and
  `203.0.113.0/24`;
- placeholder Tailnet names and hostnames;
- synthetic or operator-owned test services;
- sanitized output that contains no credentials or private deployment data.

Do not demonstrate the project with a restricted third-party resource, publish
working access credentials or exit nodes, maintain destination blocklists, or
present the repository as a hosted access service. A disclaimer does not make
an otherwise inappropriate example acceptable.

## Accurate claims

State that the project is pre-alpha and describe only behavior supported by
current evidence. In particular:

- the guaranteed path is IPv4/TCP with managed system DNS;
- selected UDP and QUIC are rejected;
- IPv6, DoH/DoT, ECH, direct-IP traffic, and shared-CDN effects remain explicit
  limitations;
- a live rollout begins with one `/32` canary and a rollback deadman;
- the repository supplies software and instructions, not infrastructure or
  access credentials.

Link to the current [production-readiness matrix](production-readiness.md)
instead of describing the project as production-ready.

## Suggested article structure

1. The problem: a VPN tunnel and an egress policy solve different tasks.
2. The provider-neutral architecture.
3. Source scope and managed DNS classification.
4. Strict egress adapters: Tailscale, SOCKS5, or a Linux interface.
5. Fail-closed behavior and outage handling.
6. Canary rollout, verification, and rollback.
7. Current limitations and remaining readiness work.
8. Responsible use and operator obligations.

Before publishing for a regulated audience, refresh the applicable law and
obtain qualified review when the legal risk is material.
