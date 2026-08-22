# 0.5.0-pre-alpha validation report

Date: 2026-08-21

## Verdict

The schema-version-2 multi-source implementation is suitable for a guarded
pre-alpha canary. It is not production-ready.

## Passed evidence

- 103 unit tests, JSON Schema, shell, English-only, secret, and immutable-image
  checks pass.
- The dependency audit reports no known production dependency vulnerability.
- Disposable tunnel and proxy-container labs prove selected/direct separation,
  managed-DNS first selection, SOCKS and capture outages, direct continuity,
  source isolation, and exact cleanup.
- A separate Ubuntu 26.04 host ran one transaction with a host tunnel source
  and a proxy-container source. Preflight, enable, verify, disable, repeated
  disable, boot-helper reconciliation, source-container recreation, and safe
  uninstall passed. The source recreation was detected before reconcile.
- The reference VPN host safely removed the previous tunnel-only router before
  this candidate. Both source VPN containers remained running with unchanged
  IDs, restart counts, ports, and default routes.
- The narrow live XRay canary selected one exact domain through the managed
  Tailscale exit while an ordinary identity endpoint remained direct. Stopping
  Tailscale or the XRay capture blocked the selected destination and preserved
  ordinary traffic; both paths recovered. The server-side deadman was cancelled
  only after lifecycle verification passed.
- Two failed live apply attempts rolled back automatically and preserved the
  source VPNs. Their diagnostics led to runtime pinning of the managed SOCKS
  IPv4 address for source containers that do not use Docker service DNS.
- An external AmneziaWG2 client proved the client-scoped PREROUTING path for
  the exact-domain canary. The staged expansion then covered the discovered
  AWG2 subnet and the complete XRay container for `.ru`, `.xn--p1ai`, `.su`,
  and the retained test domain.
- The expanded runtime passed direct/strict identity separation, managed-DNS
  population, AWG2 redirect and XRay OUTPUT capture, source identity and route
  integrity, deadman cancellation, idempotent enable, and systemd startup.
- A transient userspace-exit DNS delay triggered the expected automatic
  rollback. The lifecycle now requires three consecutive health checks within
  a bounded retry window; the corrected retry passed without weakening the
  fail-closed policy.
- The installed release was upgraded while the accepted routing runtime stayed
  active. The current/previous release pointers, systemd unit, runtime status,
  and both source VPN containers remained healthy.
- A full reference-host reboot restored Docker, both Amnezia sources, systemd
  reconciliation, the managed egress, and both routing namespaces. AWG2 and
  XRay were then recreated with new container identities while preserving their
  listeners, configuration, peers, restart policy, and direct/selected routing.
- The active installation switched to the retained previous release, passed
  external AWG2 routing smoke, and switched back to the current release without
  restarting either source VPN. Final AWG2 and XRay direct/selected smoke passed.
- The maintenance run exposed excessive work when lifecycle commands overlapped
  on a 1 GiB host. Lifecycle operations are now serialized, an existing pinned
  DNS helper image is reused, and `status` performs structural checks without
  repeating the expensive strict network probes reserved for `verify`.
- A second independent Ubuntu 26.04 host completed a clean product install with
  the distribution-compatible Compose dependency, simultaneous host-tunnel and
  proxy-container sources, strict/direct separation, fail-closed SOCKS and
  capture outages, and idempotent switching. Both same-Docker-ID stop/start and
  new-ID recreation changed the kernel network namespace and were recovered.
- The installed systemd watchdog detected and repaired same-ID namespace drift
  without an operator command. The same active runtime then passed a changed-
  tree upgrade, previous-release rollback, post-switch verification, service
  disable, project-only purge, and uninstall. Post-run addresses, routes, rules,
  SSH route, Docker containers, and Docker networks matched the pre-run
  baseline; project tables, units, configuration, state, and sidecars were
  absent. The borrowed source remained outside installer ownership.
- A second-provider Ubuntu 24.04 host with an ordinary Amnezia installation
  completed the managed-Tailscale server lifecycle with simultaneous AWG2 and
  XRay sources. First enrollment, key removal, strict/direct exit separation,
  Tailscale and capture outage blocking, recovery, full-host reboot, both
  source namespace restarts, active downgrade and return, safe uninstall, and
  state-preserving reinstall passed. Source container identities and the host
  default route remained unchanged.
- The first enrollment exposed an ordering defect: a failed readiness check
  could reach credential scrubbing and recreate an unauthenticated egress.
  The transaction rolled back before routing was accepted. The lifecycle now
  requires readiness before scrubbing and again after credential-free
  recreation; a regression contract and the repeated live enrollment pass.
- A full-pool external canary exposed a packaging defect in the transient
  rollback unit: the installed private Node runtime was not passed to the
  deadman environment. Manual rollback completed before further mutation. Both
  lifecycle implementations now pass the installed runtime explicitly; the
  regression test and repeated live timer must pass before this canary is
  accepted.

All public evidence is sanitized. Hostnames, public IP addresses, client
addresses, credentials, profiles, and raw operational logs remain private.

## Remaining release gates

- Add signed or reproducible release artifacts and a supported compatibility
  matrix before a stable release claim.
- Complete an external-client AWG2 and XRay strict/direct smoke against the
  second-provider host. The server-side lifecycle result does not by itself
  prove the public ingress path from a real client.
