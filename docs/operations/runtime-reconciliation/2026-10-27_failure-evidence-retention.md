# Runtime reconciliation: failure-evidence retention

Date: 2026-10-27
Status: reconciled

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

Local unit (141/141), schema, shell, English-only, secret, and clean-host
installation checks passed. The matching code was installed on the reference
deployment, and its helper hash matched the committed source. Docker restored
the original source and router containers; fresh routing data, full egress
verification, unchanged VPN configuration and host routes, and a healthy
watchdog run were observed. A new external-client connection test remains
pending and is not implied by server-side verification.

An overlapping watchdog and data-refresh timer briefly contended for the
shared lifecycle lock during observation. The updater now waits for that lock
for up to 120 seconds instead of immediately failing; its systemd deadline
remains 180 seconds. A timeout still reports a failed refresh without
replacing the last-known-good routing data.
