# Troubleshooting

## Discovery found no source or more than one source

Run `sudo vpn-router discover --json`. The source container must be running and
contain `ip` plus either `awg` or `wg`. Discovery only considers IPv4
interfaces whose names begin with `awg`, `wg`, `tun`, or `tap`.

If there is more than one candidate, select the intended values explicitly:

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
sudo systemctl status vpn-router.service
sudo journalctl -u vpn-router.service --since today
```

`status=drifted` means the root-only manifest says routing was applied but one
or more owned resources or health checks no longer match. Do not widen the
client scope while drift exists.

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

- Ensure the client uses the managed system DNS path.
- Disable browser Secure DNS and other DoH/DoT clients for the strict test.
- Confirm the suffix is present in `destination_sets`.
- Remember that direct IP connections, ECH, IPv6, and services on unlisted
  suffixes are outside the current guarantee.
- A shared CDN address selected by DNS can affect another hostname using the
  same address until the bounded nftables timeout expires.

## Selected traffic stops

This is the intended fail-closed result when the capture or strict egress is
unavailable. Ordinary unselected traffic should remain direct. Restore the
egress, run `vpn-router verify`, and use `vpn-router disable` if the strict path
cannot be recovered promptly.

## Source container was recreated

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
  --config /var/lib/<service_name>/runtime/config.yaml
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
