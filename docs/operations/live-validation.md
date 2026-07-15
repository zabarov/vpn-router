# Live validation gate

Live validation is a separate operational stage, not a consequence of a green
local validator.

## Required evidence

- A disposable namespace-lab proof of the exact TPROXY, policy-route, and
  return-path behavior before a first client rollout.
- A read-only inventory of the target host and VPN source topology.
- Verified access recovery path.
- Backup locations and restoration commands for every affected resource.
- A disposable proof for sidecar capture and egress behavior.
- A Tailscale node and selected exit-node readiness check.
- An approved change window and explicit stop conditions.
- Smoke checks for VPN connectivity, direct traffic, selected strict traffic,
  DNS behavior, egress failure blocking, and rollback.

## Stop immediately when

- SSH recovery is uncertain.
- The AmneziaWG source or Docker topology differs from the recorded adapter
  assumptions.
- The Tailscale egress is not healthy or no exit node is selected.
- A strict policy can fall back to direct traffic.
- Backup or rollback evidence is missing.
- A VPN client loses basic connectivity; immediately remove the capture
  sidecar, its owned nftables table, and its policy route.
