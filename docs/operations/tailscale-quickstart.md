# Simple setup: Amnezia with a Tailscale exit

This is the shortest supported path for a server owner who already uses the
Amnezia application. You do not need to understand Docker, nftables, or
sing-box to follow it.

## What you install, and where

| Place | What you install | Who uses it |
| --- | --- | --- |
| Your phone or computer | AmneziaVPN | VPN users |
| Your VPN server | Amnezia, then VPN Router | Administrator |
| Your exit computer or exit server | Tailscale | Administrator |

**Do not install Tailscale directly on the VPN server.** VPN Router starts its
own isolated Tailscale container automatically. The system Tailscale package
is neither required nor used there.

An end user only opens AmneziaVPN and connects as usual. The routing policy is
applied on the server.

## Before you start

You need:

- a Debian or Ubuntu server with root or sudo access;
- AmneziaWG 2 installed on that server;
- one Amnezia client profile for testing;
- another computer or server in the desired exit location;
- a Tailscale account.

## 1. Install Amnezia normally

Use the AmneziaVPN application on your computer:

1. Select **Self-hosted VPN**.
2. Enter the server IP address, SSH login, and password or SSH key.
3. Choose the automatic installation or install AmneziaWG manually.
4. Create at least one client profile and confirm that it connects.

Amnezia installs Docker and its VPN container on the server automatically.
VPN Router uses that existing container; it does not replace or reinstall
Amnezia. See the official [Amnezia self-hosted installation
guide](https://docs.amnezia.org/documentation/instructions/install-vpn-on-server/).

## 2. Prepare the exit device

Install Tailscale on the computer or server whose public internet address you
want selected domains to use. Sign in to your Tailnet.

On macOS or Windows, open the Tailscale menu and select **Exit node** then
**Run exit node**. Keep the device powered on and prevent it from sleeping.

On Linux, install and sign in to Tailscale first. Then enable forwarding and
advertise the exit node:

```sh
printf '%s\n' \
  'net.ipv4.ip_forward = 1' \
  'net.ipv6.conf.all.forwarding = 1' | \
  sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale set --advertise-exit-node
sudo tailscale up
```

The official [Tailscale exit-node
guide](https://tailscale.com/docs/features/exit-nodes) provides current install
instructions and platform-specific details.

Then open the Tailscale [Machines page](https://login.tailscale.com/admin/machines):

1. Find the exit device.
2. Open **Edit route settings**.
3. Enable **Use as exit node**.
4. Copy its Tailscale name or `100.x.y.z` address.

If you use a custom Tailnet access policy, it must permit
`autogroup:internet`.

## 3. Create a one-off Tailscale key

VPN Router needs to add its isolated container to the same Tailnet once.

Open the Tailscale [Keys page](https://login.tailscale.com/admin/settings/keys),
select **Generate auth key**, and use:

- **One-off:** enabled;
- **Reusable:** disabled;
- **Ephemeral:** disabled;
- **Pre-approved:** enabled if device approval is active;
- a short expiry period.

Copy the key, but do not save it in the VPN Router configuration or send it in
chat. It is removed from the container after the first successful enrollment.
Tailscale documents these choices in its [auth-key
guide](https://tailscale.com/docs/features/access-control/auth-keys).

## 4. Install VPN Router

Connect to the VPN server over SSH and run:

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
```

The installer does not change or restart Amnezia.

## 5. Run the setup wizard

Keep the test Amnezia client profile available, then run:

```sh
sudo vpn-router setup
```

The wizard automatically finds the Amnezia container, VPN interface, client
subnet, and one test client. It asks only for:

1. the Tailscale exit-node name or address from step 2;
2. the domain suffixes that should use that exit.

The default suffixes are `.ru`, `.xn--p1ai`, and `.su`. This is only a domain
list, not a complete country database. Add services on other suffixes
explicitly when needed.

The wizard creates `/etc/vpn-router/router.yaml` with private file permissions.
It does not enable routing yet.

## 6. Check and enable safely

Read the one-off key without placing it in shell history:

```sh
IFS= read -r -s VPN_ROUTER_TAILSCALE_AUTH_KEY
export VPN_ROUTER_TAILSCALE_AUTH_KEY
```

Paste the key, press Enter, and run:

```sh
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY vpn-router doctor
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

`doctor` changes no routing. `enable` starts a ten-minute automatic rollback
timer. VPN Router downloads and starts its own Tailscale container during this
step; no Tailscale package is installed on the server.

## 7. Test one client

Connect the selected test profile through Amnezia and confirm:

- a normal domain uses the VPN server's usual public address;
- a selected domain uses the Tailscale exit device's public address;
- another VPN client is unchanged.

Use system DNS during this test and disable browser Secure DNS or DoH.

If the result is correct, cancel the rollback timer:

```sh
sudo vpn-router verify --cancel-deadman
```

If anything is wrong, turn routing off. Amnezia remains online:

```sh
sudo vpn-router disable
```

## 8. Apply the policy to every VPN user

Only do this after the one-client test passes:

```sh
sudo vpn-router disable
sudo vpn-router setup --all-clients --force
sudo vpn-router doctor
sudo vpn-router enable --rollback-after 600
```

The wizard discovers the complete Amnezia client subnet. It asks for the exit
node and domains again so the wider policy cannot be enabled accidentally.
The existing Tailscale enrollment is reused; no auth key is needed.

Test at least two VPN clients, then run:

```sh
sudo vpn-router verify --cancel-deadman
sudo vpn-router service-enable
```

## Everyday controls

Turn domain routing off without disconnecting Amnezia users:

```sh
sudo vpn-router disable
```

Turn it on again with an automatic rollback timer:

```sh
sudo vpn-router enable --rollback-after 600
sudo vpn-router verify --cancel-deadman
```

View status:

```sh
sudo vpn-router status
```

## What is automatic

VPN Router automatically:

- finds the server container installed by Amnezia;
- selects one test client for the first rollout;
- creates the DNS and routing configuration;
- downloads and starts an isolated Tailscale client container;
- preserves its Tailscale enrollment across restarts;
- blocks selected traffic instead of leaking it if the exit is unavailable;
- provides a server-side rollback timer and an on/off switch.

You perform only three external actions manually:

1. install Amnezia through the Amnezia application;
2. install Tailscale on the exit device and approve it as an exit node;
3. create a one-off Tailscale key for first enrollment.

## Current limits

- The guaranteed mode is IPv4/TCP with managed system DNS.
- Selected UDP and QUIC are rejected so applications can retry over TCP.
- IPv6, browser DoH/DoT, ECH, and direct-IP connections are outside the strict
  guarantee.
- If the exit device sleeps or goes offline, selected traffic is blocked;
  ordinary traffic continues through the normal Amnezia server exit.
