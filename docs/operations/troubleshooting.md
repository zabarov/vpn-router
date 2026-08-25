# Troubleshooting

## Enable rolls back while the Tailscale exit is starting

The lifecycle waits for three consecutive strict-egress health checks and
retries for up to one minute. A temporary DNS delay inside a newly started
userspace exit should recover without operator action. If enable still rolls
back, inspect the root-only failure directory reported by the command and test
the configured health-check URL through the selected exit. Do not bypass the
health check or change `failure_mode` to direct.

## Discovery found no source

Run `sudo vpn-router discover --json`. A tunnel container must be running and
contain `ip` plus either `awg` or `wg`. Tunnel discovery considers IPv4
interfaces beginning with `awg`, `wg`, `tun`, or `tap`. XRay/V2Ray discovery
uses the running container name and image only; it never reads proxy config.

Multiple supported candidates are expected: the version-3 wizard selects them
together. To configure one explicit legacy tunnel source instead, use:

```sh
sudo vpn-router configure \
  --preset amnezia-tailscale \
  --source-container amnezia-awg \
  --source-interface awg0 \
  --client-addresses 10.8.1.2/32 \
  --output /etc/vpn-router/router.yaml
```

Replace all example topology values. If no peer `/32` is listed, create one
test VPN client first or pass its exact VPN address explicitly.

## Start with secret-free status

```sh
sudo vpn-router status
sudo vpn-router data-status
sudo systemctl status vpn-router.service vpn-router-watchdog.timer vpn-router-data-update.timer
sudo journalctl -u vpn-router.service -u vpn-router-watchdog.service -u vpn-router-data-update.service --since today
```

`status_health=drifted` means the root-only manifest says routing was applied
but one or more owned resources or namespace identities no longer match. A
healthy container source reports `namespace_identity=matched`. Do not widen
the client scope while drift exists.

## Preflight never becomes ready

Check that Docker is running, the configured container source is healthy when
used, the VPN interface exists in the selected namespace, and the strict egress
healthcheck is reachable from that namespace. The container source with managed
Tailscale also requires a Docker version whose `docker network connect`
supports gateway priorities.

For Tailscale first enrollment, provide `VPN_ROUTER_TAILSCALE_AUTH_KEY` only in
the root command environment. Later starts require the persisted Tailscale
state, not the key.

Also verify that the exit device advertises exit-node capability, an admin has
enabled **Use as exit node**, it is awake and online, and any custom Tailnet
policy permits `autogroup:internet`.

## Selected domains do not use the strict exit

- Run `sudo vpn-router diagnose example.org` and inspect the matched selector,
  policy, expected egress, and data freshness.
- Country CIDRs and exact-domain addresses work without client DNS. Confirm
  the country code or exact name is in `destination_sets`.
- For suffix-only rules, ensure the client uses managed system DNS. Secure DNS,
  DoH/DoT, private resolvers, and ECH make suffix matching best effort.
- Shared CDN addresses can route another hostname on the same IP through the
  same egress. Use `always-direct` only after testing that tradeoff.

## Routing data is DEGRADED or FAILED

`DEGRADED` means a fresh last-known-good country or domain entry is still in
use. `FAILED` means required initial data is missing, integrity validation
failed, or `max_stale` expired. Existing strict sets remain fail-closed; an
invalid refresh never replaces them. Check HTTPS access to RIPEstat, server DNS,
the data-update journal, and then run:

```sh
sudo vpn-router data-update
sudo vpn-router data-status
sudo vpn-router verify --full
```

The updater follows the exact configuration last activated by `enable`, even
when `--config` selects a non-default path. Its root-only pointer is removed by
`disable`, `rollback`, and uninstall. If a timer was active during upgrade, the
installer reloads and restarts it so the next run remains scheduled.

`vpn-router diagnose example.com` also reads the active nftables rule counters
for every source namespace. `egress_status=READY` means the project-owned
Tailscale exit is running and online. External SOCKS5 and Linux-interface exits
are reported as `EXTERNAL_MANAGED`; use `vpn-router verify --full` for their
active reachability check.

## Selected traffic stops

This is the intended fail-closed result when the capture or strict egress is
unavailable. Ordinary unselected traffic should remain direct. Restore the
egress, run `vpn-router verify`, and use `vpn-router disable` if the strict path
cannot be recovered promptly.

## Source container was restarted or recreated

When the systemd recovery timer is enabled, wait up to two minutes and check
`vpn-router status`. `watchdog=DEFERRED` in the journal means the source is not
ready yet; no routing mutation was attempted. Manual recovery is:

Run:

```sh
sudo vpn-router reconcile --rollback-after 600
sudo vpn-router verify --cancel-deadman
```

Reconciliation refuses to delete a matching table or network in the new source
namespace. If it reports ambiguous resources, capture `docker inspect`, the
source namespace nftables rules, and project network labels before making any
manual change.

## Configuration changed while applied

Lifecycle commands intentionally require the exact configuration hash stored
at enable time. Use the root-only copy to inspect or disable the old deployment:

```sh
sudo vpn-router disable \
  --config /var/lib/<service_name>/runtime/multi-source-config.yaml
```

Then validate and enable the new `/etc/vpn-router/router.yaml` with a deadman.

## Upgrade failed

An unsuccessful install or upgrade leaves `current` unchanged. If the new
version was selected but its control behavior is incompatible, run from the
checkout used for the upgrade:

```sh
sudo ./install.sh rollback-version
sudo vpn-router verify
```

Never use Git history rewriting as an operational rollback.

## Uninstall refused

The installer preserves all files if active routing could not be disabled and
verified safely. Restore the source container if needed, use its stored config
to run `disable`, and repeat uninstall. Use `--purge` only after backup and only
when removal of configuration and Tailscale state is intended.

## Evidence and recovery data

Root-only manifests, generated artifacts, baselines, failure logs, and source
recreation records live under `/var/lib/<service_name>/runtime/`. Do not publish
that directory: it can contain private topology and operational metadata even
though credential values are excluded by design.
