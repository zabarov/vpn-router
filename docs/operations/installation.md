# Installation and lifecycle

This guide starts with a clean Debian or Ubuntu host and ends with a reversible
VPN Router service. Keep the first rollout limited to one test client `/32`.

## Supported installation target

The bundled installer supports x86-64 and ARM64 Debian/Ubuntu hosts with
systemd. It installs VPN Router under `/opt/vpn-router`, configuration under
`/etc/vpn-router`, a stable `/usr/local/sbin/vpn-router` command, and an
opt-in systemd service. It downloads the pinned official Node.js runtime and
verifies its SHA-256 checksum.

The managed runtime supports either an existing healthy AmneziaWG2 Docker
container or a pre-existing VPN interface in the host Linux namespace. A host
`linux_interface` source must use an external SOCKS5 endpoint or a different
pre-existing tunnel interface; managed Tailscale currently requires the
container-source adapter.

## 1. Prepare the VPN and strict egress

Before installing VPN Router, provide:

- an existing AmneziaWG2 container or host VPN interface and its interface name;
- the VPN client subnet and one unused test-client address;
- one strict egress: a Tailscale exit node, reachable unauthenticated SOCKS5
  endpoint, or pre-existing tunnel interface;
- a credential-free HTTPS URL for egress health checks.

Do not use the administrator workstation as the first test client. VPN Router
does not install or replace the source VPN server.

## 2. Install from a release checkout

Clone or unpack a reviewed release, then run:

```sh
git clone https://github.com/rim/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
```

`--install-dependencies` supports Debian and Ubuntu. It installs common network
tools. When Docker already comes from the distribution, it first installs that
distribution's compatible Compose v2 package. Only when Docker is absent does
it configure Docker's official package repository and install Docker Engine
plus Compose. Without this flag, the installer reports missing prerequisites
and does not change system packages.

The source checkout is no longer required after a successful installation.
Each installed tree is immutable and addressed by the project version plus a
source hash. The stable `current` symlink is replaced atomically.

## 3. Create the private configuration

Run the interactive wizard:

```sh
sudo vpn-router configure --output /etc/vpn-router/router.yaml
```

The wizard writes mode `0600`, refuses accidental overwrite, stores no secret,
and defaults to one canary `/32`. For unattended provisioning:

```sh
sudo vpn-router configure \
  --non-interactive \
  --output /etc/vpn-router/router.yaml \
  --source-type amneziawg2_container \
  --source-container amnezia-awg \
  --source-interface awg0 \
  --client-scope address_list \
  --client-addresses 10.8.1.2/32 \
  --egress-type tailscale_socks \
  --exit-node exit-node.example.ts.net \
  --healthcheck-url https://example.com/ \
  --domains .ru,.xn--p1ai,.su
```

Replace every example topology value. The `.ru`, `.xn--p1ai`, and `.su`
suffixes are merely an example policy; add or remove suffixes for the region or
services you need. See the [configuration reference](../developer/configuration.md)
for external SOCKS5 and Linux-interface egresses.

Validate without changing networking:

```sh
sudo vpn-router validate
sudo vpn-router preflight
```

## 4. Enroll Tailscale without storing an auth key

For first Tailscale enrollment only, export an ephemeral or reusable auth key
in the root session or inject it from a secret manager:

```sh
export VPN_ROUTER_TAILSCALE_AUTH_KEY='set-in-a-secret-manager-or-root-session'
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

The egress is immediately recreated from persisted state with an empty
`TS_AUTHKEY` environment. Subsequent starts use the encrypted Tailnet state
under `/var/lib/<service_name>/egress-tailscale/` and need no auth key.

For external SOCKS5 or Linux-interface egress, run the same `enable` command
without the environment variable.

## 5. Verify the canary and cancel the deadman

`enable` always arms a server-side rollback timer before changing networking.
While it is active, test from the canary VPN client:

1. an ordinary domain uses the source VPN server's normal egress;
2. a selected domain uses the strict exit;
3. system DNS resolves both classes;
4. stopping the strict egress blocks selected destinations rather than leaking
   them directly;
5. an unselected client remains unaffected;
6. SSH and host/source default routes remain unchanged.

Inspect internal state without cancelling the timer:

```sh
sudo vpn-router status
sudo vpn-router verify
```

Only after the external matrix passes:

```sh
sudo vpn-router verify --cancel-deadman
```

To expand from a canary to more users, edit the configuration only while the
router is disabled, validate it, then repeat enable and verification. Use an
explicit `address_list` before changing to the complete VPN `subnet`.

## 6. Use the routing switch

```sh
sudo vpn-router disable
sudo vpn-router enable --rollback-after 600
```

`disable` removes only project-owned policy resources. It preserves the source
VPN, its clients, external egresses, and Tailscale enrollment state. `rollback`
is the failure-recovery alias; both operations are idempotent.

## 7. Enable boot recovery

Enable boot recovery only after the manual canary and outage matrix has passed:

```sh
sudo vpn-router service-enable
```

The oneshot systemd service waits up to three minutes for the source VPN,
reconciles the recorded deployment with a ten-minute deadman, verifies internal
adapter health, and only then cancels that timer. On service stop it disables
routing before Docker stops.

A normal container restart retains its identity. If the source container was
recreated, `reconcile` archives the previous root-only manifest, removes stale
project-owned sidecars, and applies to the new namespace. It refuses recovery
when project-named nftables or network resources already exist in that new
namespace.

```sh
sudo vpn-router service-status
sudo vpn-router service-disable
```

Automatic boot verification proves internal health, not the complete external
client acceptance matrix. Monitor both direct and strict paths after host,
Docker, VPN, or exit-node maintenance.

## 8. Upgrade or roll back the installed code

From a newly reviewed release checkout:

```sh
sudo ./install.sh upgrade
sudo vpn-router version
sudo vpn-router status
sudo vpn-router verify
```

Upgrade validates the installed configuration with the candidate before
atomically changing `current`. It does not widen client scope, restart the
source VPN, or automatically replace the active data plane. The previous code
tree is retained:

```sh
sudo ./install.sh rollback-version
sudo vpn-router verify
```

Disable routing before a configuration schema migration or any upgrade that
the release notes mark as data-plane incompatible.

## 9. Uninstall

Safe uninstall disables an active owned runtime first and aborts if cleanup
cannot be proved. It removes installed code, command, and service while keeping
configuration and persistent egress state:

```sh
sudo ./install.sh uninstall
```

After making a separate backup, explicitly purge configuration and owned state:

```sh
sudo ./install.sh uninstall --purge
```

Purge never removes the source VPN container, VPN profiles, an external SOCKS5
service, or an external tunnel interface.

## Local contributor verification

Contributors can test the repository without installing it:

```sh
npm ci
npm run check
npm run check:containers
npm run check:clean-host
```

The clean-host check uses a disposable pinned Ubuntu container to prove install,
configuration, validation, upgrade, version rollback, safe uninstall, and
configuration retention. It is not a substitute for a real VPN data-path or
systemd reboot test.
