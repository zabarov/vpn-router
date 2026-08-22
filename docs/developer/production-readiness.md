# Production readiness

The project is a `0.6.0-alpha.1` candidate, not production-ready. Schema-3
laboratory and guarded reference-host acceptance pass. A second independent
host passes installation, data refresh, downgrade, restoration, and removal,
but it has not completed a live two-source VPN routing canary.

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Configuration | Schema 3, schema 1/2 migration, negative validation | Passed locally; candidate CI pending |
| Routing data | RIPEstat, exact-domain resolver, last-known-good, stale and shrink guards | Passed in deterministic tests and on two independent Ubuntu hosts |
| Egress portability | Tailscale SOCKS, external SOCKS5, Linux interface fixtures | External SOCKS5 passes both container-source and real host-interface paths; Linux-interface strict egress remains fixture-only |
| Routing switch | Transactional multi-source enable/disable with preserved VPN and egress state | Passed for simultaneous AWG2 and XRay sources on the guarded reference host |
| Multi-client | Two selected clients and one excluded client in a disposable lab | Passed in the disposable redirect lab |
| Whole pool | Explicit test subnet with no interface-only wildcard | Passed in the disposable redirect lab |
| Failure safety | Capture, DNS, SOCKS and egress outages fail closed | Tunnel and proxy-container labs pass; managed-Tailscale XRay live outages pass on two providers; second-provider external tunnel-client outage smoke remains |
| Restart lifecycle | Host reboot, Docker restart and source recreation | Reference-host and second-provider real-Amnezia reboot/reconciliation pass; independent same-ID watchdog and new-ID reconcile also pass |
| Upgrade lifecycle | Previous configuration to candidate and downgrade proof | Active reference-host downgrade and restoration pass; independent-host install, downgrade, restoration, and uninstall pass |
| Observability | READY/DEGRADED/FAILED, diagnosis, scope, adapter health, drift and counters | Data status, JSON status, diagnosis, source health, egress state, and per-source selector counters pass |
| Security | Root-only state, immutable images, secret scan and dependency review | Partial |
| Documentation | Install, configure, operate, recover and troubleshoot from a clean host | Updated for schema 3; independent clean-reader validation remains a beta gate |
| Live rollout | AWG2 and XRay canaries with backup and deadman rollback | Guarded simultaneous schema-3 canary passes on one reference host; second live VPN host remains |

## Release levels

- `pre-alpha`: architecture and controlled reference evidence; interfaces may
  change.
- `alpha`: multi-client and lifecycle behavior pass disposable integration
  tests, a clean-host packaging test, and a separately gated live reference
  rollout.
- `beta`: clean-host install, reboot/recreation, upgrade/downgrade, monitoring,
  and at least two source/egress combinations are proved.
- `stable`: supported compatibility matrix, documented maintenance policy,
  signed/reproducible release artifacts, and repeatable recovery evidence.

No release level may be promoted only because generated configuration validates
or CI is green. The integrated runtime scenarios for that level must have fresh
evidence.

## Safe rollout sequence

1. Render and validate without changing runtime.
2. Enable one `/32` with a deadman rollback.
3. Enable a small `address_list`; keep an excluded control client.
4. Enable the explicit VPN subnet only after strict, direct, outage, isolation,
   disable and rollback checks pass.
5. Cancel the deadman only after the smoke matrix is complete.
6. Keep the previous release and configuration available for downgrade.

Any direct leak, ordinary VPN outage, client-scope widening, default-route or
SSH-route change, incomplete cleanup, or secret exposure stops the rollout and
requires rollback.
