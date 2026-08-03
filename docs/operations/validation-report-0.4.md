# 0.4.0-pre-alpha validation report

## Scope

This report covers the portable installation and operator lifecycle added after
the 0.3 data-plane rollout. It contains no private host, client, Tailnet, or VPN
profile data.

## Passed repository evidence

- The complete unit, schema, shell, English-only, and secret suite passes.
- A pinned clean Ubuntu 24.04 container installs the project without a host
  Node.js dependency.
- The installer downloads the pinned official Node.js 24 LTS archive and
  verifies its architecture-specific SHA-256 checksum.
- The installed command creates a mode-`0600` canary configuration and validates
  it independently of the source checkout.
- A content change produces a separate immutable release and preserves the old
  `current` target as `previous`.
- `rollback-version` restores the previous target atomically.
- Safe uninstall removes code and command while retaining the private
  configuration.
- Static lifecycle tests prove the systemd service uses bounded readiness,
  reconciliation with a deadman, internal verification, and disable-on-stop.
- Static recovery tests prove source-container identity drift archives the old
  manifest and fails closed when matching resources exist in the replacement
  namespace.
- A non-production Ubuntu 26.04 host with distribution Docker installed the
  matching distribution Compose v2 package, installed the product without a
  host Node.js runtime, and executed the installed immutable release.
- The real host-interface lab proved selected traffic depended on external
  SOCKS5, ordinary traffic remained direct during SOCKS and capture outages,
  both paths recovered, disable restored ordinary routing, and the boot helper
  completed start/verify/deadman-cancel/stop.
- The failed registry attempts and the successful run all completed exact-name
  cleanup. Final inventory found no lab container, interface, namespace,
  nftables table, enabled service, installation directory, or added Compose
  package.

## What this does not prove

- A real host reboot with Docker, AmneziaWG2, Tailscale, and external client
  traffic.
- A live source-container recreation followed by strict/direct client probes.
- Active data-plane upgrade and downgrade between two published releases.
- A strict-egress data-path run using the `linux_interface` egress adapter; the
  host-source run used external SOCKS5.
- IPv6, selected UDP, DoH/DoT, ECH, direct-IP, or shared-CDN guarantees.

## Verdict

The repository is repeatably installable for both bundled source contracts and
has an operator-complete packaging lifecycle. Release status remains pre-alpha
until the real reboot/recreation, active upgrade, and Linux-interface egress
matrices have fresh evidence.
