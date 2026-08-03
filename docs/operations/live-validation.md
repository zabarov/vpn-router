# Live validation gate

A green unit test or successful `preflight` is not permission to route a client.
Every new host starts with one dedicated `/32` canary and a server-side rollback
deadman.

## Evidence required before apply

- source container ID, image, interface, addresses, routes, rules, and nftables;
- Docker containers and networks relevant to the deployment;
- exact absent-or-owned status of the configured table, container names, and
  network names;
- Tailscale state/enrollment readiness and exit-node availability;
- root-only timestamped backup with SHA-256 manifest;
- verified SSH route and an independent recovery path;
- approved `/32`, change window, rollback command, smoke matrix, cleanup path,
  and stop conditions;
- passing disposable redirect/SOCKS/DNS/out-of-scope-client lab.

## Canary matrix

Use different destination IPs for strict and direct targets. A second client
outside the `/32` is mandatory.

| Scenario | Required result |
| --- | --- |
| Direct hostname/IP from canary | Uses the existing Amnezia direct egress |
| Selected suffix from canary | Uses the selected Tailscale exit |
| `.ru`, `.xn--p1ai`, `.su` | Selected after managed DNS response |
| Explicit non-country suffix | Selected only when configured explicitly |
| First TCP connection after DNS | Already captured; never races direct |
| Tailscale/SOCKS stopped | Selected traffic blocked; direct still works |
| Tailscale/SOCKS restarted | Selected traffic recovers without restarting sing-box |
| sing-box stopped | Redirected connection fails locally; direct still works |
| Second client outside `/32` | Behavior unchanged in every state |
| Host default and SSH routes | Byte-for-byte logical baseline unchanged |
| Rollback, then repeat rollback | Baseline restored; both calls succeed |
| Apply after rollback | Recreates only owned resources and verifies |

Record expected external IPs privately. Public evidence should state only
whether direct and strict results were different and matched their expected
egresses.

## Browser and DNS conditions

Disable Chrome Secure DNS and other DoH/DoT resolvers during guaranteed-mode
testing. Flush the canary DNS cache before the first-attempt test. ECH,
direct-IP connections, shared CDN addresses, and applications with private DNS
remain limitations. Do not label them supported based on an unrelated page
load.

## Stop and rollback immediately when

- any selected request reaches direct egress;
- any out-of-scope client changes behavior;
- host or source-namespace default/SSH routes change;
- the source container ID or `awg0` topology changes;
- a sidecar failure interrupts direct traffic;
- backup, manifest ownership, timer, or rollback verification is missing;
- DNS answers are returned before their selected IP appears in the nftables set;
- management access becomes uncertain.

Do not cancel the deadman on partial evidence. Run `verify --cancel-deadman`
only after every applicable row passes.
