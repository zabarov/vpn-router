# Production readiness

The project is currently pre-alpha. Schema-2 now has disposable, reference-host,
independent clean-Linux, and second-provider real-Amnezia server lifecycle
evidence. Production status still requires external-client acceptance on that
second provider plus the stable-release security and artifact gates below.

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Configuration | Multi-source schema, migration, negative validation | Passed in unit and schema tests |
| Egress portability | Tailscale SOCKS, external SOCKS5, Linux interface fixtures | External SOCKS5 passes both container-source and real host-interface paths; Linux-interface strict egress remains fixture-only |
| Routing switch | Transactional multi-source enable/disable with preserved VPN and egress state | Passed on the reference host and an independent Ubuntu host |
| Multi-client | Two selected clients and one excluded client in a disposable lab | Passed in the disposable redirect lab |
| Whole pool | Explicit test subnet with no interface-only wildcard | Passed in the disposable redirect lab |
| Failure safety | Capture, DNS, SOCKS and egress outages fail closed | Tunnel and proxy-container labs pass; managed-Tailscale XRay live outages pass on two providers; second-provider external tunnel-client outage smoke remains |
| Restart lifecycle | Host reboot, Docker restart and source recreation | Reference-host and second-provider real-Amnezia reboot/reconciliation pass; independent same-ID watchdog and new-ID reconcile also pass |
| Upgrade lifecycle | Previous configuration to candidate and downgrade proof | Clean-host packaging plus active independent-host upgrade, downgrade, verification, uninstall and exact cleanup pass |
| Observability | Scope, adapter health, drift and counters in secret-free status | Scope, adapter health and drift implemented; counter summary pending |
| Security | Root-only state, immutable images, secret scan and dependency review | Partial |
| Documentation | Install, configure, operate, recover and troubleshoot from a clean host | Updated for schema 2 and watchdog recovery; clean-reader validation pending |
| Live rollout | AWG2 and XRay canaries with backup and deadman rollback | Combined XRay and external AWG2 reference canaries pass; second-provider server lifecycle passes, but its external-client smoke remains |

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
