# Deployment contract

This document defines the future production boundary. It is not an instruction
to apply changes to a running server without the live validation gate.

## Generated artifacts

From one validated YAML configuration, generate:

```sh
node bin/vpn-router.mjs render-sing-box --config ./router.yaml > ./sing-box.json
node bin/vpn-router.mjs render-nftables --config ./router.yaml > ./vpn-router.nft
node bin/vpn-router.mjs render-dnsmasq --config ./router.yaml > ./dnsmasq.conf
```

The generated sing-box file never contains a Tailscale credential. A one-time
Tailscale auth key belongs only in the deployment environment for
`vpn-router-egress`, which runs in its own Docker network namespace. Persist
its state directory outside the repository and remove the auth key from the
deployment environment after successful enrollment; the Compose template
accepts an empty `TS_AUTHKEY` when an enrolled state directory already
exists. Never commit either the state directory or a file containing an auth
key.

## Owned resources

The configuration owns only these resources:

- one nftables table named by `resources.nftables_table`;
- the routing mark, mask, route table, and rule priority declared under
  `resources`;
- the capture, DNS, and isolated egress service names declared by the
  deployment;
- the state directories mounted into those services.

It must never flush the global nftables ruleset, alter Docker's own tables, or
replace the host default route.

## Apply order for a future gated rollout

1. Record the current owned-resource state and save a timestamped backup.
2. Start and smoke-test the isolated Tailscale SOCKS egress by itself. It must
   use the shared Docker network, not the Amnezia container namespace.
3. Run `nft -c -f ./vpn-router.nft` and `sing-box check -c ./sing-box.json`.
4. Create the local policy route for the configured mark and route table.
5. Apply only the generated nftables table.
6. Start the capture and DNS sidecars with the source container explicitly
   named in the compose environment.
7. Run the smoke plan. Stop and restore the backup if any strict destination
   reaches the direct path.

## Rollback order

1. Stop and remove only the capture and DNS sidecars.
2. Delete only the policy rule and route table entries declared in the
   configuration.
3. Delete only `table inet <resources.nftables_table>`.
4. Stop and remove the isolated egress service only if the deployment itself is
   being removed; it never shares the Amnezia network namespace.
5. Restore the recorded backup if the owned-resource state differs from its
   pre-change value.
6. Confirm AmneziaWG connectivity and direct traffic before closing the change.

## Compose template

`deploy/compose.amneziawg2.yaml` deliberately uses
`network_mode: container:<source>`. This makes the sidecar see `awg0` before
NAT. It also means that a replacement of the source container requires a
sidecar restart and renewed health check.

The template must be invoked with an explicit source container name, the
Docker network shared by the Amnezia container and the isolated Tailscale
egress sidecar, and a local generated configuration path. For a managed domain policy it also needs
`VPN_ROUTER_DNSMASQ_CONFIG`; the DNS sidecar shares the VPN source namespace
and has `NET_ADMIN` solely to update this project's named nftables sets. It
contains neither a server hostname nor a credential.
