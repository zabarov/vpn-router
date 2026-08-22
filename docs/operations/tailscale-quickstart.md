# Simple setup: Amnezia with a Tailscale exit

This path is for a server owner who wants selected domains from all supported
Amnezia protocols to use another computer or server as their internet exit.

## Where each component runs

| Device | Component |
| --- | --- |
| User phone/computer | AmneziaVPN client |
| VPN server | Amnezia installed normally, plus VPN Router |
| Exit computer/server | Tailscale configured as an exit node |

Do not install the system Tailscale package on the VPN server. VPN Router runs
its own isolated userspace Tailscale container and preserves its enrollment.

## 1. Install Amnezia normally

In the AmneziaVPN application, choose self-hosted VPN, enter the server SSH
details, install the desired protocols, and prove each client connection works.
VPN Router is added afterwards and never stores the server password.

## 2. Configure the exit device

Install Tailscale on the computer or server whose public address should be used
for selected domains. Sign in and advertise it as an exit node.

On macOS or Windows, use the Tailscale menu to enable **Run exit node**. Keep
the device awake. On Linux, follow the official forwarding instructions and
run:

```sh
sudo tailscale set --advertise-exit-node
```

Open the Tailscale [Machines page](https://login.tailscale.com/admin/machines),
select the device, approve **Use as exit node**, and note its full Tailscale
name or `100.x.y.z` address. See the official [exit-node
guide](https://tailscale.com/docs/features/exit-nodes).

## 3. Create a one-off enrollment key

On the Tailscale [Keys page](https://login.tailscale.com/admin/settings/keys),
create a short-lived, one-off, non-reusable, non-ephemeral key. Pre-approve it
if device approval is enabled. Do not place it in YAML, Git, screenshots, or
chat.

## 4. Install and configure VPN Router

On the VPN server:

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
sudo vpn-router discover
sudo vpn-router setup
```

The wizard discovers supported tunnel sources and XRay/V2Ray containers. It
selects them together and asks for the exit-node name, countries, exact
domains, suffixes, and optional direct exceptions.
For tunnel sources it starts with one discovered client `/32`; proxy-container
sources necessarily cover all users of that container.

The wizard does not enable routing.

## 5. Check and enable with rollback

```sh
IFS= read -r -s VPN_ROUTER_TAILSCALE_AUTH_KEY
export VPN_ROUTER_TAILSCALE_AUTH_KEY
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY vpn-router doctor
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

The key is used only for enrollment. VPN Router persists Tailscale state and
recreates the running container without the key.

## 6. Test every protocol

For AmneziaWG2 and XRay separately, verify:

- an ordinary domain uses the VPN server's normal exit;
- a selected domain uses the Tailscale exit;
- selected traffic is blocked if the exit is stopped;
- ordinary traffic remains available;
- country and exact-domain routing still works with browser Secure DNS enabled;
- suffix-only routing works through the managed system DNS path.

If all checks pass:

```sh
sudo vpn-router verify --cancel-deadman
```

If anything is wrong:

```sh
sudo vpn-router disable
```

Amnezia and its users stay online when the routing overlay is disabled.

## 7. Expand tunnel clients and enable boot

After a one-client tunnel canary passes, regenerate the configuration for the
whole discovered tunnel subnet:

```sh
sudo vpn-router disable
sudo vpn-router setup --all-clients --force
sudo vpn-router doctor
sudo vpn-router enable --rollback-after 600
```

Test at least two tunnel clients plus every proxy protocol, then run:

```sh
sudo vpn-router verify --cancel-deadman
sudo vpn-router service-enable
```

## Everyday controls

```sh
sudo vpn-router status
sudo vpn-router data-status
sudo vpn-router diagnose obr.site
sudo vpn-router disable
sudo vpn-router enable --rollback-after 600
```

## Current limits

The alpha candidate is IPv4/TCP-only. Selected UDP and QUIC are rejected.
Country, static-CIDR, and pre-resolved exact-domain routing do not depend on
client DNS. IPv6 is unsupported; DoH/DoT, ECH, and private resolvers make
arbitrary suffix matching best effort. Shared-CDN addresses can over-route
neighboring names.
