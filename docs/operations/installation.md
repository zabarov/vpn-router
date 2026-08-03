# Installation and lifecycle

## Prerequisites

The managed AmneziaWG2 adapter requires:

- a Linux host with systemd;
- Docker Engine and Compose plugin with network gateway-priority support;
- Node.js 22 or newer;
- an existing, healthy AmneziaWG2 container and `awg0` interface;
- `/dev/net/tun` for an isolated client test;
- a Tailscale exit node that is online and allowed by Tailnet policy;
- a unique test-client IPv4 address expressed as an `address_list` `/32`.

Do not use the operator's own workstation as the first test client.

## Local validation

```sh
npm ci
npm test
npm run validate
./lab/verify.sh
./lab/redirect/verify.sh
```

Render and container-check the private deployment configuration without
contacting a server:

```sh
./scripts/prepare-amneziawg2-artifacts.sh \
  --config ./router.yaml \
  --output-dir ./build/vpn-router
```

The command checks sing-box, nftables, and dnsmasq against pinned images. The
output directory is local deployment material and must not be committed.

## Native AmneziaWG2 client test

An Amnezia `vpn://` profile is sufficient when it embeds the native AWG2
configuration. On a separate Linux host:

```sh
sudo ./scripts/run-isolated-amneziawg2-client.sh \
  --input ./client-profile.vpn
```

The runner creates a mode-`0600` native profile in a private temporary
directory, starts the pinned `amneziavpn/amneziawg-go` image without host
networking or `--privileged`, and removes the container and extracted profile.
It never prints profile contents. Delete the original transferred `.vpn` file
after the result has been recorded.

When Node.js is intentionally absent on the isolated host, extract locally and
transfer only the mode-`0600` native file, then use
`--native-config ./awg0.conf`. Delete the transferred file immediately after
the runner exits.

## Prepare the live configuration

Copy `config.example.yaml` outside Git. Set:

- the real Amnezia container and interface names;
- one canary `/32` in `client_scope.addresses` for the first enable;
- a unique `resources.service_name` and nftables table;
- the Tailscale exit-node full hostname or IP;
- `proxy_server` to `<service_name>-egress`.
- a credential-free HTTPS `healthcheck_url` that is reachable through the
  selected exit.

For first enrollment, export the auth key only in the root session:

```sh
export VPN_ROUTER_TAILSCALE_AUTH_KEY='set-in-a-secret-manager-or-root-session'
```

The lifecycle immediately recreates a newly enrolled egress with the persisted
state and an empty `TS_AUTHKEY`, then verifies the container environment. Also
remove the key from the invoking root shell after the command returns. State is
persisted under `/var/lib/<service_name>/egress-tailscale/`.

## Lifecycle commands

Run preflight first. It is read-only with respect to host routes, firewall,
containers, and networks; its validation containers are disposable.

```sh
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  ./scripts/vpn-router-lifecycle.sh preflight --config ./router.yaml
```

Enable always requires a server-side rollback timeout:

```sh
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  ./scripts/vpn-router-lifecycle.sh enable \
  --config ./router.yaml \
  --rollback-after 600
```

The lifecycle stores a root-only baseline, generated artifacts, copied config,
checksums, and ownership manifest below `/var/lib/<service_name>/runtime/`.
It refuses pre-existing names or the configured nftables table without a
matching active manifest.

Check local state without cancelling the deadman:

```sh
sudo ./scripts/vpn-router-lifecycle.sh status --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh verify --config ./router.yaml
```

Only after the external acceptance matrix passes, cancel the timer:

```sh
sudo ./scripts/vpn-router-lifecycle.sh verify \
  --config ./router.yaml \
  --cancel-deadman
```

Disable is the normal idempotent routing switch:

```sh
sudo ./scripts/vpn-router-lifecycle.sh disable --config ./router.yaml
```

It preserves the Tailscale state directory and the existing AmneziaWG2
container. A recreated source container invalidates verification; re-run
preflight and enable after confirming the new namespace. Use `rollback` for
failure recovery; `apply` remains an alias for `enable`.

While a manifest is active, all lifecycle commands require the exact config
revision recorded at apply time. If the operator copy changed, use the
root-only `/var/lib/<service_name>/runtime/config.yaml` to verify or roll back.

## Current deployment boundary

`linux_interface` sources and `socks5`/`linux_interface` strict egresses are
supported by validation and artifact generation, but
the bundled managed lifecycle does not yet install host-network processes for
that adapter. Treat a generic-interface deployment as an operator-owned runtime
until a separate lifecycle adapter is released and proven.
