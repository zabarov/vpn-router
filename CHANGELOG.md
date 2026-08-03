# Changelog

All notable changes are documented here.

## 0.2.0-pre-alpha - Unreleased

- Enforce one IPv4 `/32` canary, one strict policy, and one default-direct
  policy in the initial runtime contract.
- Scope every DNS, TCP redirect, selected-UDP, QUIC, and forward-guard rule to
  the canary address.
- Use Linux TCP REDIRECT with a sing-box redirect inbound. A forward-hook guard
  rejects selected packets that were not claimed by NAT, while a stopped
  listener fails closed without policy routing.
- Route all DNS-selected capture traffic directly to the strict SOCKS egress;
  remove secondary SNI/domain classification and its broad final block.
- Split static and DNS-derived nftables sets, cap managed DNS and cache TTL at
  300 seconds, and retain dynamic addresses for ten minutes so cache expiry
  cannot race strict-set expiry.
- Add a two-client, two-target Docker lab that proves the first managed-DNS
  connection, redirect and SOCKS outage behavior, direct continuity, timeout
  expiry, isolation, and cleanup.
- Resolve the isolated SOCKS service through uncached container DNS and require
  three consecutive HTTPS readiness probes so a Tailscale restart recovers
  without restarting sing-box.
- Add secret-safe extraction of native AWG2 configuration from an Amnezia
  `vpn://` text key and a native Linux validation runner using the pinned
  AmneziaWG2 image with limited capabilities.
- Add guarded `preflight`, `apply`, `status`, `verify`, and `rollback` lifecycle
  commands with root-only baseline evidence, owned resources, an isolated
  Tailscale network, and a systemd rollback deadman.
- Quote every generated runtime assignment, reject unknown configuration
  fields, and refuse active manifests whose exact stored config has changed.
- Drop all Linux capabilities from the capture sidecar; grant the managed DNS
  sidecar only the capabilities needed to update nftables sets and drop user.
- Recreate a newly enrolled Tailscale egress from persisted state with an empty
  auth-key environment and make credential scrubbing part of verification.
- Reject executable `wg-quick` hooks in imported AWG2 profiles and remove
  profile-supplied DNS and automatic routing directives in the isolated test.
- Add SHA-pinned CI for static checks, unit/schema validation, secret and
  language guards, and both disposable Docker labs.
- Capture host and source routing baselines and require semantic address,
  route, rule, and SSH-route restoration before rollback can report success;
  ignore only expiring lease and router-advertisement timers.
- Make the namespace lab wait for its capture tool before probing, eliminating
  a startup race in clean CI runners.
- Remove TPROXY marks and policy-route tables after live kernel tracing showed
  that local delivery was not portable in the target Amnezia container
  namespace.
- Pin AmneziaWG2, sing-box, Tailscale, Alpine, and Ubuntu container inputs by
  digest.
- Document the IPv4/TCP, managed-DNS, DoH/ECH, shared-CDN, direct-IP, and IPv6
  limitations without claiming production readiness.

## 0.1.0 - Unreleased

- Establish the public pre-alpha repository baseline.
- Define a provider-neutral router configuration contract and local validator.
- Document AmneziaWG2 and generic Linux ingress adapters plus a Tailscale
  userspace egress.
- Add managed suffix routing for `.ru`, `.xn--p1ai`, `.su`, and arbitrary
  user-supplied ASCII suffixes.
