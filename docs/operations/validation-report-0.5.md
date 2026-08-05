# 0.5.0-pre-alpha validation report

Date: 2026-08-05

## Verdict

The schema-version-2 multi-source implementation is suitable for a guarded
pre-alpha canary. It is not production-ready.

## Passed evidence

- 97 unit tests, JSON Schema, shell, English-only, secret, and immutable-image
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

All public evidence is sanitized. Hostnames, public IP addresses, client
addresses, credentials, profiles, and raw operational logs remain private.

## Remaining release gates

- Complete the selected-domain check from a real external AmneziaWG2 client;
  a server-originated process cannot exercise the client-scoped PREROUTING rule.
- Repeat the combined live canary after source-container recreation.
- Prove real host reboot and Docker daemon restart recovery.
- Validate active-version upgrade/downgrade while routing is enabled.
- Add signed or reproducible release artifacts and a supported compatibility
  matrix before a stable release claim.
