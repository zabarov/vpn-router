# Amnezia and Tailscale quick start

This guide configures selected domains from every Amnezia VPN client to leave
through a Tailscale exit node. Other domains keep using the Amnezia server's
normal internet connection.

Start with one test client. Expanding to every VPN user is the final step, not
the first one.

## The three devices

- **Exit device:** a computer or server in the location whose public internet
  address selected domains should use. It runs Tailscale and stays online.
- **VPN server:** the Debian or Ubuntu host that already runs the AmneziaWG2
  server. VPN Router is installed here.
- **Test client:** one phone or computer with an Amnezia profile. It proves the
  policy before other VPN users are included.

The exit device and VPN server can be in different countries. End users do not
install Tailscale; they continue to use only their normal Amnezia profile.

## 1. Prepare the Tailscale exit device

Create or sign in to a Tailnet, install Tailscale on the exit device, and sign
in with the same Tailnet account.

On macOS or Windows, open the Tailscale menu and select **Exit node** then
**Run exit node**. Prevent the device from sleeping while it is expected to
carry traffic.

On Linux, install and sign in to Tailscale, enable forwarding, and advertise
the node:

```sh
printf '%s\n' \
  'net.ipv4.ip_forward = 1' \
  'net.ipv6.conf.all.forwarding = 1' | \
  sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale set --advertise-exit-node
sudo tailscale up
```

Open the Tailscale [Machines page](https://login.tailscale.com/admin/machines),
find the device, open **Edit route settings**, and enable **Use as exit node**.
Record its Tailscale device name or `100.x.y.z` address. If the Tailnet has a
custom access policy, it must allow the VPN Router node to reach
`autogroup:internet`.

The authoritative and platform-specific instructions are in the official
[Tailscale exit-node guide](https://tailscale.com/docs/features/exit-nodes).

## 2. Create a one-off key for VPN Router

Open the Tailscale [Keys page](https://login.tailscale.com/admin/settings/keys)
and select **Generate auth key**.

Use these settings for the first installation:

- one-off, not reusable;
- not ephemeral, because VPN Router preserves this node across restarts;
- pre-approved if device approval is enabled;
- a short expiry period;
- an optional server tag if the Tailnet policy already defines one.

Copy the key once. Do not paste it into a configuration file, issue, commit, or
chat. VPN Router uses it only for first enrollment and then recreates the
container without the key. See the official [auth-key
guide](https://tailscale.com/docs/features/access-control/auth-keys) and
[secure handling guide](https://tailscale.com/docs/features/access-control/auth-keys/how-to/secure-auth-keys).

## 3. Install VPN Router

Run on the VPN server:

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
```

Connect the test client to Amnezia, then inspect the detected server topology:

```sh
sudo vpn-router discover
```

Discovery is read-only. It reports container, interface, VPN subnet, and the
number of configured client `/32` addresses. It never prints VPN peer keys.

## 4. Create the canary configuration

The beginner preset discovers a unique Amnezia container and uses one real
client `/32` as the initial canary:

```sh
sudo vpn-router configure \
  --preset amnezia-tailscale \
  --output /etc/vpn-router/router.yaml
```

At the prompt, enter the exit-node device name or its Tailscale IP. Review the
domain suffixes. `.ru`, `.xn--p1ai`, and `.su` are examples, not a complete
country database. Services on `.com`, `.net`, direct IP addresses, or shared
CDNs need deliberate entries and can have shared-IP effects.

If discovery finds multiple sources, repeat the command with the container and
interface shown by `discover`:

```sh
sudo vpn-router configure \
  --preset amnezia-tailscale \
  --source-container amnezia-awg \
  --source-interface awg0 \
  --client-addresses 10.8.1.2/32 \
  --output /etc/vpn-router/router.yaml
```

Replace every example topology value in the second command.

## 5. Run the safe diagnostic and enable

Read the key without putting it in shell history:

```sh
IFS= read -r -s VPN_ROUTER_TAILSCALE_AUTH_KEY
export VPN_ROUTER_TAILSCALE_AUTH_KEY
```

Paste the key, press Enter, then run:

```sh
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY vpn-router doctor
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

`doctor` changes no routing. `enable` starts with a ten-minute server-side
deadman. If setup fails, VPN Router attempts immediate cleanup and the deadman
remains the independent safety net.

## 6. Test from the canary client

Use system DNS on the client. Disable browser Secure DNS/DoH for this test.
Then confirm:

1. an ordinary domain shows the Amnezia server's normal public address;
2. a selected domain shows the exit device's public address;
3. both types resolve and load;
4. another VPN client is unchanged.

Inspect the server without cancelling the timer:

```sh
sudo vpn-router status
sudo vpn-router verify
```

Only after the external checks pass, cancel the deadman:

```sh
sudo vpn-router verify --cancel-deadman
```

If anything is wrong, use the routing switch. Amnezia itself stays running:

```sh
sudo vpn-router disable
```

## 7. Expand to every VPN user

First disable routing and obtain the exact `client_subnet` from
`sudo vpn-router discover --json`. Then recreate the configuration with an
explicit subnet. This example is intentionally not copy-ready until its values
are replaced:

```sh
sudo vpn-router disable
sudo vpn-router configure \
  --non-interactive \
  --force \
  --preset amnezia-tailscale \
  --source-container amnezia-awg \
  --source-interface awg0 \
  --client-scope subnet \
  --client-subnet 10.8.1.0/24 \
  --exit-node exit-node.example.ts.net \
  --output /etc/vpn-router/router.yaml
sudo vpn-router doctor
sudo vpn-router enable --rollback-after 600
```

Existing Tailscale enrollment is reused, so the auth key is not needed again.
Repeat the full client test matrix before cancelling the new deadman. Only then
enable automatic boot reconciliation:

```sh
sudo vpn-router verify --cancel-deadman
sudo vpn-router service-enable
```

From this point, every address in that VPN subnet receives the same domain
policy. The operational switch remains:

```sh
sudo vpn-router disable
sudo vpn-router enable --rollback-after 600
```

## Limits that users need to know

- The guaranteed pre-alpha mode is IPv4/TCP with managed system DNS.
- Selected UDP and QUIC are rejected so applications can fall back to TCP.
- IPv6, browser DoH/DoT, ECH, and direct-IP connections are outside the strict
  guarantee.
- If the exit device is asleep or offline, selected traffic is blocked instead
  of leaking through the normal Amnezia exit. Other traffic remains direct.
- A home computer can be an exit device for a small installation. A dedicated
  Linux server is more suitable for continuous or multi-user traffic.
