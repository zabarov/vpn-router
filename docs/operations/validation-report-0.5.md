# 0.5.0-pre-alpha validation report

Date: 2026-08-05

## Verdict

The schema-version-2 multi-source implementation is suitable for a guarded
pre-alpha canary. It is not production-ready.

## Passed evidence

- 98 unit tests, JSON Schema, shell, English-only, secret, and immutable-image
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
  and both source VPN containers remained healthy; active downgrade execution
  remains a separate gate.

All public evidence is sanitized. Hostnames, public IP addresses, client
addresses, credentials, profiles, and raw operational logs remain private.

## Remaining release gates

- Repeat the combined live canary after source-container recreation.
- Prove real host reboot and Docker daemon restart recovery.
- Validate active-version downgrade while routing is enabled.
- Add signed or reproducible release artifacts and a supported compatibility
  matrix before a stable release claim.
