# Changelog

All notable changes are documented here.

## 0.5.0-pre-alpha - Unreleased

- Add schema version 2 with simultaneous `tunnel_interface` and
  `container_egress` sources under one strict policy and one routing switch.
- Add read-only discovery of AmneziaWG2, WireGuard-compatible tunnels, and
  XRay/V2Ray containers without reading VPN credentials or proxy configuration.
- Add fail-closed nftables `OUTPUT` capture for proxy containers, managed DNS,
  routing-mark loop prevention, selected-UDP rejection, and IPv6 rejection.
- Add a transactional multi-namespace lifecycle with shared egress, per-source
  capture/DNS sidecars, source-container identity tracking, and reconciliation.
- Add explicit, non-destructive migration from schema version 1.
- Add a disposable proxy-container lab that proves direct isolation, first-DNS
  selection, strict SOCKS routing, and fail-closed SOCKS/capture outages.
- Keep the existing VPN containers, their configuration, ports, default routes,
  and persisted Tailscale enrollment outside VPN Router ownership.

## 0.4.0-pre-alpha - Unreleased

- Add a clean-host Debian/Ubuntu installer with an SHA-256-verified private
  Node.js LTS runtime, immutable content-addressed releases, and an atomic
  `current` switch independent of the Git checkout.
- Add a stable `vpn-router` operator command for configuration, validation,
  lifecycle, routing-switch, reconciliation, and systemd operations.
- Add an interactive and automation-friendly configuration wizard that writes
  mode-`0600` validated YAML without storing credentials.
- Add a beginner `vpn-router setup` wizard that discovers an Amnezia install,
  asks only for the Tailscale exit and domain policy, and can explicitly expand
  from one test client to the discovered VPN subnet with `--all-clients`.
- Require an explicit domain policy for the Amnezia/Tailscale preset, use only
  reserved domains in active public examples, and add a responsible-use
  policy.
- Add opt-in systemd boot reconciliation with bounded source readiness, a
  rollback deadman, health verification, and routing cleanup on service stop.
- Add a managed host-namespace lifecycle for WireGuard, OpenVPN, IPsec, and
  other pre-existing Linux VPN interfaces using external SOCKS5 or a separate
  tunnel-interface egress.
- Recover safely from source-container recreation by archiving the old
  root-only manifest and refusing ambiguous resources in the new namespace.
- Add atomic upgrade, previous-version rollback, safe uninstall with retained
  configuration/state, and separately explicit purge behavior.
- Add a disposable clean Ubuntu packaging test covering install, configure,
  validate, changed-tree upgrade, version rollback, uninstall, and retained
  configuration.
- Publish complete English install, boot, upgrade, removal, and troubleshooting
  procedures while keeping the remaining live reboot and generic-source
  integration evidence limits explicit.
- Remove the unnecessary Docker Hub Alpine pull from live preflight, validate
  nftables with the target namespace's own `nft`, and use Canonical's official
  Azure registry Ubuntu image for the DNS build and clean-host lab.
- Prove the installed host-interface lifecycle on a non-production Ubuntu host:
  strict/direct routing, SOCKS and capture outages, recovery, disable,
  boot-helper start/stop, exact cleanup, and distribution-compatible Compose
  dependency handling.

## 0.3.0-pre-alpha - Unreleased

- Replace the single-client enforcement model with an explicit client scope:
  either a staged list of IPv4 `/32` addresses or the complete VPN subnet.
- Render every owned nftables rule through one visible client-scope set and
  reject implicit interface-wide or `0.0.0.0/0` selection.
- Add provider-neutral strict egress contracts and sing-box rendering for an
  external SOCKS5 service or a separately managed Linux tunnel interface while
  retaining Tailscale SOCKS as the managed reference adapter.
- Add idempotent `enable` and `disable` lifecycle commands as the operator
  routing switch. Disabling removes only project-owned policy resources and
  preserves the VPN and Tailscale enrollment state.
- Report the configured scope mode, entry count, strict egress type, resource
  health, and drift without exposing credentials.
- Expand the disposable external-SOCKS5 redirect lab to two selected clients
  and one excluded control client, including fail-closed egress and capture
  outages, then prove explicit whole-subnet selection and staged-scope restore.
- Publish the production contract, readiness gates, staged rollout model, and
  honest managed-adapter boundary.
- Add schema-checked complete examples for an external SOCKS5 exit and a
  separately managed Linux tunnel interface.
- Record the sanitized staged live rollout from one canary to all existing
  peers and then the explicit full VPN subnet, including routing-switch,
  fail-closed outage, recovery, peer-integrity and route-stability evidence.
- Use digest-only sing-box image references so provider naming checks do not
  misclassify a version tag as a server-specific identifier.

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
  300 seconds, and retain selected addresses until lifecycle cleanup so a
  longer-lived client DNS cache cannot cause a later direct leak.
- Add a two-client, two-target Docker lab that proves the first managed-DNS
  connection, redirect and SOCKS outage behavior, direct continuity,
  selected-address persistence, isolation, and cleanup.
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
