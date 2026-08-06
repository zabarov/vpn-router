# Installation and lifecycle

VPN Router is an overlay. Install and test the source VPN first. For Amnezia,
use the normal AmneziaVPN self-hosted flow with the server login and password;
Amnezia creates its own containers. VPN Router never needs those credentials.

## Requirements

- Debian or Ubuntu with root access and systemd;
- Docker Engine and Compose v2;
- an already working supported tunnel or XRay/V2Ray container;
- one of: a Tailscale exit node, external SOCKS5, or a separate Linux egress
  interface.

## Install

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
```

The installer adds a private pinned Node.js runtime, immutable release
directories, `/usr/local/sbin/vpn-router`, and a disabled-by-default systemd
unit. It does not install or change the source VPN.

## Discover and configure

```sh
sudo vpn-router discover
sudo vpn-router setup
```

`discover` is read-only. `setup` selects every supported detected Amnezia
tunnel and XRay/V2Ray container, then asks for the shared Tailscale exit node
and domain suffixes. The generated `/etc/vpn-router/router.yaml` is mode `0600`
and routing remains disabled.

For external SOCKS5 or Linux-interface egress, use the advanced wizard:

```sh
sudo vpn-router configure
```

Run `vpn-router migrate-config --input old.yaml --output new.yaml` to convert a
version-1 file without overwriting it.

## Preflight and safe enable

For first Tailscale enrollment, export a short-lived one-off key only for the
command process:

```sh
IFS= read -r -s VPN_ROUTER_TAILSCALE_AUTH_KEY
export VPN_ROUTER_TAILSCALE_AUTH_KEY
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY vpn-router doctor
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

For an already enrolled Tailscale state or an external egress:

```sh
sudo vpn-router doctor
sudo vpn-router enable --rollback-after 600
```

`enable` captures a root-only baseline and arms an independent server-side
rollback before applying any source. Test every source, one ordinary domain,
one selected domain, DNS, and strict-egress failure. Only then cancel the timer:

```sh
sudo vpn-router verify --cancel-deadman
```

## Routing switch

```sh
sudo vpn-router status
sudo vpn-router disable
sudo vpn-router enable --rollback-after 600
```

`disable` removes only VPN Router resources and preserves source VPNs and the
persisted Tailscale enrollment. It is idempotent.

## Container recreation

If Amnezia recreates a configured source container:

```sh
sudo vpn-router reconcile --rollback-after 600
sudo vpn-router verify --cancel-deadman
```

Reconciliation compares stored container IDs and refuses ambiguous ownership.

## Start at boot

Enable boot reconciliation only after a successful manual acceptance run:

```sh
sudo vpn-router service-enable
```

Turn boot routing off without removing the product:

```sh
sudo vpn-router service-disable
sudo vpn-router disable
```

## Upgrade and removal

```sh
git pull --ff-only
sudo ./install.sh upgrade
sudo ./install.sh rollback-version   # if the new release must be reverted
sudo ./install.sh uninstall          # preserves config and state
sudo ./install.sh uninstall --purge  # explicit config/state removal
```

Uninstall refuses to continue if active routing cannot be safely disabled. It
never removes source VPN containers or externally managed egress services.

## Verification for contributors

```sh
npm ci
npm run check
npm run check:containers
npm run check:clean-host
```

Production claims additionally require a real Linux lifecycle, source
recreation, reboot, rollback, and external-client acceptance evidence. The
sanitized reference deployment now includes combined AWG2/XRay external-client
acceptance, full-host reboot, source recreation, active downgrade, and return
to the current release. Each independent deployment must repeat these gates.
