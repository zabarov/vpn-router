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

The normal generated sing-box file has no credential value. For a first,
non-interactive enrollment only, the operator may explicitly render a local
one-time file from an environment variable:

```sh
VPN_ROUTER_TAILSCALE_AUTH_KEY='...' \
  node bin/vpn-router.mjs render-sing-box --config ./router.yaml \
  --include-auth-key-from-env > ./sing-box.initial.json
chmod 600 ./sing-box.initial.json
```

Start the sidecar once with that file, wait until the Tailscale state directory
contains an enrolled node, then replace it with the normal no-secret rendered
file and securely remove the initial file. Never commit either the state
directory or a rendered file containing an auth key.

## Owned resources

The configuration owns only these resources:

- one nftables table named by `resources.nftables_table`;
- the routing mark, mask, route table, and rule priority declared under
  `resources`;
- the service name and Tailscale state directory declared by the deployment;
- the sidecar container created from `deploy/compose.amneziawg2.yaml`.

It must never flush the global nftables ruleset, alter Docker's own tables, or
replace the host default route.

## Apply order for a future gated rollout

1. Record the current owned-resource state and save a timestamped backup.
2. Run `nft -c -f ./vpn-router.nft` and `sing-box check -c ./sing-box.json`.
3. Create the local policy route for the configured mark and route table.
4. Apply only the generated nftables table.
5. Start the sidecar with the source container explicitly named in the compose
   environment.
6. Run the smoke plan. Stop and restore the backup if any strict destination
   reaches the direct path.

## Rollback order

1. Stop and remove only the VPN Router sidecar.
2. Delete only the policy rule and route table entries declared in the
   configuration.
3. Delete only `table inet <resources.nftables_table>`.
4. Restore the recorded backup if the owned-resource state differs from its
   pre-change value.
5. Confirm AmneziaWG connectivity and direct traffic before closing the change.

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
