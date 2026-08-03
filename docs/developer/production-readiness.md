# Production readiness

The project is currently pre-alpha. The working reference deployment proves the
IPv4/TCP data path for the complete configured VPN client pool, but production
status still requires the following gates.

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Configuration | Client list/subnet selectors, migration, negative validation | Passed in unit, container and live staged rollout |
| Egress portability | Tailscale SOCKS, external SOCKS5, Linux interface fixtures | External SOCKS5 passes both container-source and real host-interface paths; Linux-interface strict egress remains fixture-only |
| Routing switch | Idempotent enable/disable with preserved VPN and egress state | Passed between live list and subnet stages |
| Multi-client | Two selected clients and one excluded client in a disposable lab | Passed in the disposable redirect lab |
| Whole pool | Explicit test subnet with no interface-only wildcard | Passed in the disposable redirect lab |
| Failure safety | Capture, DNS, SOCKS and egress outages fail closed | Tailscale and capture outages passed in container and live stages; broader matrix remains |
| Restart lifecycle | Host reboot, Docker restart and source recreation | Boot helper start/stop passes on real Linux; full host reboot and source recreation remain pending |
| Upgrade lifecycle | Previous configuration to candidate and downgrade proof | Atomic changed-tree upgrade and previous-version rollback pass the clean-host packaging lab; active data-plane upgrade evidence pending |
| Observability | Scope, adapter health, drift and counters in secret-free status | Scope, adapter health and drift implemented; counter summary pending |
| Security | Root-only state, immutable images, secret scan and dependency review | Partial |
| Documentation | Install, configure, operate, recover and troubleshoot from a clean host | Passed for both bundled source contracts; real host-interface data-path evidence remains pending |
| Live rollout | Canary, list and subnet stages with backup and deadman rollback | Passed on the reference AmneziaWG2 plus Tailscale deployment |

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
