# Runtime reconciliation: failure-evidence retention

Date: 2026-10-27
Status: pending_promotion

## Incident and containment

On one reference deployment, repeated recovery failures created hundreds of
root-only diagnostic copies. They consumed roughly 4.2 GiB on a small root
filesystem. After a later reboot, Docker did not load the existing VPN and
router containers while the filesystem had no free space.

The operator preserved the active router configuration, Tailscale state,
container metadata, and representative first/latest failure samples in a
private, checksummed backup. A scoped cleanup removed 480 redundant generated
snapshot directories; two samples remained. This freed roughly 3.8 GiB.
Restarting Docker loaded the original source VPN and router containers. The
router's stale country/domain data was refreshed, then full structural and
egress verification passed. No VPN profile, Docker image/volume, Tailscale
state, host default route, or source VPN configuration was removed or changed.

## Source promotion

The lifecycle now limits each captured command to 32 KiB, retains at most
eight generated failure snapshots, and records container state without full
Docker environment data. Both lifecycle variants share the same private
retention helper. The public troubleshooting guide explains the manual
handling of historical snapshots from older installations.

## Verification and remaining gate

Local unit, schema, shell, English-only, secret, and clean-host installation
checks passed. Live release promotion and a new external-client connection
test remain required before this event can be marked reconciled. The
repository does not claim that server-side verification alone proves a VPN
client session.
