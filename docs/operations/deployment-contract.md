# Deployment ownership and rollback contract

## Generated artifacts

One validated YAML file produces:

```sh
node bin/vpn-router.mjs render-sing-box --config ./router.yaml --source <tag>
node bin/vpn-router.mjs render-nftables --config ./router.yaml --source <tag>
node bin/vpn-router.mjs render-dnsmasq --config ./router.yaml
node bin/vpn-router.mjs render-runtime-plan --config ./router.yaml
```

These outputs contain no Tailscale auth key. The runtime plan contains validated
topology identifiers only; it never emits a credential value.

## Owned resources

A Tailscale-backed managed deployment owns only:

- `table inet <resources.nftables_table>`;
- one capture and optional DNS container per source namespace, plus
  `<service_name>-egress`;
- Docker networks `<service_name>-control` and `<service_name>-proxy`;
- `/var/lib/<service_name>/`.

For an external SOCKS5 or Linux-interface egress, the egress container and
Docker networks are not created. The external service or interface is checked
before and after enable but remains operator-owned and is never stopped or
reconfigured by VPN Router.

Every source VPN or proxy container is borrowed, not owned. For Tailscale,
connecting a container source to the internal proxy network is recorded and uses negative gateway
priority. The lifecycle compares its default-route fingerprint before and
after that connection.

For a host `tunnel_interface` source, capture and DNS sidecars use host
networking and the one owned nftables table lives in the host namespace. The
source VPN interface remains borrowed: VPN Router does not create, restart,
reconfigure, or delete it. Managed Tailscale exposes a loopback-only SOCKS port
for host sources and the private proxy network for container sources.

The internal proxy network is available only to container sources and the
Tailscale egress. Any host listener is bound to loopback only. Tailscale also
joins a separate control network and runs in userspace mode.

## Apply transaction

1. Validate config, interface, source container, IPv4-only boundary, names, and
   absent-or-managed resources.
2. Render and syntax-check sing-box and nftables. For a domain-suffix policy,
   also render and validate dnsmasq.
3. Build the pinned dnsmasq image only when managed DNS is required. An
   IP/CIDR-only policy does not start or pull a DNS sidecar.
4. Capture a root-only baseline, write an `applying` ownership manifest, and
   arm the server-owned rollback deadman before the first network mutation.
5. For Tailscale, start only its sidecar and require a running backend, an online selected exit,
   and a successful Tailnet ping to that exit. After first enrollment, recreate
   the egress from its persisted state with an empty `TS_AUTHKEY`, then verify
   that the credential is absent from the container environment.
6. For Tailscale, connect each container source to the internal proxy network without changing its
   default route, then prove both the SOCKS port and the configured HTTPS
   health check through SOCKS. For an external SOCKS5 or Linux-interface
   egress, run three consecutive adapter-specific HTTPS checks without creating
   or changing the external dependency.
7. Apply one identically named owned nftables table in each distinct source
   namespace. No policy rule or route table is added.
8. Start per-namespace capture and, when required, DNS sidecars.
   Verify every owned component and mark the manifest `applied`.

Any failure after the intent manifest triggers rollback. Repeating `apply` with
the exact verified configuration is a no-op except for rearming the deadman.
An active manifest rejects a changed configuration; use its root-only stored
copy for verification or rollback before applying a new revision.

## Rollback transaction

1. Stop and remove every owned capture and DNS sidecar.
2. If each source container ID still matches the manifest, delete the owned
   nftables table and proxy-network connection in that namespace.
3. Remove the project Compose objects, including the Tailscale container and
   two project networks when that adapter was selected. Never stop an external
   SOCKS5 service or tunnel interface.
4. Keep `/var/lib/<service_name>/egress-tailscale/` intact.
5. Compare host and source addresses, routes, policy rules, and the recorded SSH
   route with the pre-apply snapshots. Address and route order is normalized,
   and expiring lease/router-advertisement timers are ignored; all stable
   network fields must still match. The owned nftables table must be absent;
   full ruleset bytes are not compared because unrelated packet counters move.
6. Mark the root-only manifest `rolled_back` only after those checks pass.

If the source container was recreated, its old namespace no longer exists; the
lifecycle will not delete similarly named resources from the new namespace.
Rollback is safe to repeat. It returns `ALREADY_ROLLED_BACK` for a verified
completed rollback and `ALREADY_ABSENT` when no manifest exists.

The lifecycle never flushes the global nftables ruleset, changes the host
default route or DNS, deletes unrelated Docker resources, modifies source VPN
or proxy configuration, or removes Tailscale state.

## Installed release and boot ownership

The installer owns `/opt/vpn-router`, `/usr/local/sbin/vpn-router`,
`/var/lib/vpn-router-installer`, and the optional `vpn-router.service` plus
`vpn-router-watchdog.service` and `.timer` systemd units. Configuration under
`/etc/vpn-router` and runtime state under `/var/lib/<service_name>` are
preserved by default uninstall.

An upgrade writes a new immutable content-addressed release, validates the
installed configuration with that candidate, atomically changes `current`, and
retains the old target as `previous`. It does not restart the source VPN or
silently widen client scope.

The opt-in systemd service calls `reconcile` at boot with a rollback deadman.
Its timer then performs a structural check every minute. It acts only when the
manifest says `applied`, defers while source preflight is unavailable, and uses
targeted fail-closed repair rather than a whole-runtime rollback.
If the source container identity changed, recovery archives the old manifest
and removes only stale project-owned Compose resources. It refuses recovery if
the replacement namespace already contains the configured nftables table or is
already attached to the project proxy network.
