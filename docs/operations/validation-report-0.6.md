# 0.6.0-alpha.1 validation report

This report records sanitized acceptance evidence for the schema-3 alpha
candidate. It contains no host addresses, VPN client addresses, credentials,
Tailnet names, private configuration, or raw logs. The result is evidence for
an alpha candidate, not a production-ready claim.

## Automated acceptance

The candidate passes the repository unit, schema, shell, English-only, secret,
dependency, container data-plane, and clean-host checks. Covered scenarios
include:

- country selection from an IPv4 destination without a client DNS request;
- exact-domain selection from server-maintained answers;
- managed-DNS observation for suffixes;
- direct-override precedence over country, exact-domain, static, and observed
  strict selectors;
- last-known-good retention after invalid, empty, or suspiciously smaller
  country-provider responses;
- fail-closed strict routing when capture or the selected egress is absent;
- simultaneous tunnel-interface and proxy-container sources;
- idempotent lifecycle operations and updater compensation.

## Guarded reference-host canary

One authorized Ubuntu host with an ordinary Amnezia installation ran the
schema-3 candidate over existing AmneziaWG2 and XRay sources. The rollout used
a root-only backup, one tunnel client address, a server-side ten-minute
deadman, and unchanged source-container and default-route boundaries.

The following checks passed:

- live RIPEstat country data and server-side exact-domain refresh reached
  `READY`;
- ordinary destinations kept the existing VPN-server exit;
- selected country and exact-domain destinations used the strict Tailscale
  egress;
- a direct override won when its address was also in a strict country set;
- stopping the project-owned Tailscale egress or one capture sidecar blocked
  selected traffic while ordinary traffic remained available;
- `reconcile` restored the stopped capture without recreating or editing an
  Amnezia source;
- JSON status, domain diagnosis, selector counters, full verification, and the
  periodic data-update service passed;
- host, source-container, and SSH-peer route semantics remained unchanged.

An active downgrade then disabled schema 3, installed the previous release,
enabled and verified its stored schema-2 configuration, disabled it, restored
the alpha candidate, re-enabled schema 3, refreshed data, and cancelled the
new deadman. This test exposed and then verified the fix for a lifecycle race:
disable must stop an already-running data-update service in addition to its
timer before changing versions.

## Independent-host lifecycle

A separate clean Ubuntu host verified the candidate archive checksum and then
completed:

- clean installation without enabling routing;
- schema-3 example validation;
- a real RIPEstat and exact-domain data refresh into root-only state;
- systemd unit verification with the data timer left disabled;
- installation of the previous release and restoration of the candidate;
- uninstall, repeated uninstall, and temporary-artifact cleanup.

The host's existing private VPN test material was not read or modified. This
host did not provide a second live AWG2/XRay client path, so it is packaging and
data-lifecycle evidence rather than a second live-routing acceptance.

## Verdict and remaining gates

Verdict: the implemented scope is accepted as `0.6.0-alpha.1` candidate
evidence. It is not beta, stable, or production-ready.

Beta still requires a second independent live VPN-host canary and seven days
without a P0 or P1 incident. Stable additionally requires the documented
30-day observation window, an external instruction review, reproducible signed
artifacts, checksums, an SBOM, and repeated recovery evidence.
