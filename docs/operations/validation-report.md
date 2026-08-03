# 0.2.0-pre-alpha validation report

This report records the sanitized evidence used to accept the pre-alpha
routing model on 2026-08-02. It deliberately excludes addresses, hostnames,
credentials, profile contents, peer keys, and raw operational logs.

It is evidence for one controlled canary, not a claim that arbitrary hosts are
production-ready. Every deployment must repeat the live validation gate.

## Evidence layers

### Disposable Docker lab

The two-client, two-target lab passed with the release routing model:

- the canary's first TCP connection after a managed DNS answer was selected;
- the strict target was reachable only through TCP REDIRECT and SOCKS;
- stopping SOCKS blocked strict traffic while direct traffic continued;
- restarting SOCKS recovered in the same sing-box process;
- stopping sing-box blocked strict traffic while direct traffic continued;
- a second client outside the configured `/32` remained unaffected;
- a selected nftables element persisted after managed DNS stopped, preventing
  client-side DNS cache lifetime from creating a later direct leak;
- all project containers, networks, and volumes were removed.

The same lab passed after removing all Linux capabilities from the capture
sidecar and reducing the DNS sidecar to its explicit capability set.

### Isolated native Linux client

A dedicated Linux host imported the supplied Amnezia `vpn://` profile through
the repository extractor and ran the pinned AmneziaWG2 container without host
networking. The test proved:

- a non-zero AWG2 handshake timestamp;
- successful DNS and HTTPS through the tunnel;
- non-zero received and transmitted byte counters;
- unchanged host default routes, policy rules, and SSH-peer route;
- removal of the disposable container and extracted native profile.

### Live `/32` canary

The managed adapter was applied only to the isolated client's VPN address. The
canary produced different, expected direct and selected-egress identities.
Managed DNS selected `.ru`, `.xn--p1ai`, `.su`, and an explicit test suffix;
the `.su` routing counters passed, while application availability of the chosen
`.su` endpoint was not asserted because that endpoint was unavailable through
the selected exit.

Failure checks passed:

- with Tailscale/SOCKS stopped, selected traffic was blocked and direct traffic
  continued;
- after Tailscale returned, selected traffic recovered without a sing-box
  restart;
- with sing-box stopped, selected traffic was blocked and direct traffic
  continued;
- every live generated rule retained the exact source `/32` boundary;
- host and source defaults, policy rules, host DNS, SSH route, source container
  identity, and unrelated container identity remained unchanged.

Lifecycle checks passed for first apply, verify, repeated apply, second verify,
rollback, and repeated rollback. Final inspection found no project container,
network, or nftables table. The AmneziaWG2 source and its Tailscale state were
preserved. The dedicated test peer was then revoked server-side and temporary
derived profiles were deleted.

## Post-live hardening

After the live canary, changes that do not alter the selected/direct packet
model added:

- POSIX quoting for every lifecycle runtime assignment;
- strict unknown-field and resource-name validation in both semantic checks
  and the published JSON Schema;
- exact active-manifest config hashing and per-invocation config snapshots;
- internal post-rollback comparison against host, source, and SSH-route
  baselines;
- configurable Tailscale SOCKS listen-port propagation;
- selected-exit and HTTPS-through-SOCKS checks in `verify`;
- automatic recreation of a newly enrolled Tailscale container with an empty
  auth-key environment;
- removal of unnecessary capture-sidecar capabilities.

Unit, schema, shell, language, secret, and both disposable container suites
were repeated after this hardening. The live test peer had already been revoked,
so these final safeguards are covered by local/container evidence rather than
a second live canary.

## Remaining release gates

This version remains pre-alpha. Production readiness requires separate proof
of at least:

- an actual expired deadman timer executing rollback without an operator;
- host reboot and Docker restart recovery;
- source-container recreation and upgrade handling;
- a reviewed upgrade path between repository versions;
- any scope wider than one IPv4 `/32`;
- IPv6, selected UDP, DoH/DoT, ECH, direct-IP, and shared-CDN behavior.
