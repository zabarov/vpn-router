# VPN Router

VPN Router applies one strict, domain-oriented routing policy to traffic that
arrives through a VPN. Selected IPv4/TCP destinations leave through a strict
egress adapter; all other traffic keeps the VPN server's normal direct egress.

```text
VPN client -> VPN interface -> managed DNS/IP set -> TCP REDIRECT -> sing-box
                                                            -> strict egress -> exit node
                     non-selected traffic --------------------------> direct
```

The policy model is provider-neutral. `linux_interface` represents WireGuard,
OpenVPN, IPsec, or another VPN interface in the host Linux namespace, while
`amneziawg2_container` represents a container-owned namespace. The routing core
does not contain country or provider names.

> Status: `0.4.0-pre-alpha`. The generator, secret-safe AmneziaWG2 profile
> extraction, source-scoped fail-closed rules, disposable integration lab, and
> guarded AmneziaWG2/Tailscale lifecycle are implemented. A clean-host
> installer, configuration wizard, systemd reconciliation, version rollback,
> and safe uninstall are also available. Every live deployment still starts
> with a `/32` canary, a backup, a rollback deadman, and operator-reviewed
> acceptance evidence. This release is not production-ready.

## Current guarantee

The pre-alpha contract intentionally stays narrow:

- one active IPv4 source with an explicit client address list or VPN subnet;
- one strict destination policy and one `default -> direct` policy;
- managed plain DNS for domain suffixes;
- TCP capture only;
- selected UDP and QUIC rejection;
- no IPv6 route claim;
- no direct fallback when capture or the strict egress is unavailable.

The example regional profile contains `.ru`, `.xn--p1ai`, and `.su`. It is only
a suffix list. Services hosted on `.com`, `.net`, shared CDNs, or direct IPs
must be added deliberately and can have shared-IP side effects.

Chrome Secure DNS, other DoH/DoT clients, ECH, direct-IP connections, and IPv6
are outside the guaranteed mode. Use system DNS and disable those alternate
paths for a strict canary.

## Install on a server

On a Debian or Ubuntu host with an existing AmneziaWG2 Docker container:

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
sudo vpn-router discover
sudo vpn-router configure \
  --preset amnezia-tailscale \
  --output /etc/vpn-router/router.yaml
```

The installer provides a pinned private Node.js runtime, the `vpn-router`
command, atomic upgrades, a previous-version rollback, safe uninstall, and an
opt-in systemd service. It does not install or replace the source VPN.

For the simplest complete path, follow [Amnezia and Tailscale quick
start](docs/operations/tailscale-quickstart.md). It covers preparing an exit
device, creating a one-off Tailscale key, safe first enrollment, testing one
client, expanding to all VPN users, and using the routing switch.

For other egress adapters, read the complete [installation and lifecycle
guide](docs/operations/installation.md) before `enable`. The first live client
scope must be one test `/32`, and enable always requires a server-side rollback
timer.

## Contributor quick start

Requires Node.js 22 or newer and Docker for container checks.

```sh
npm ci
npm test
npm run validate
./lab/redirect/verify.sh
```

Copy `config.example.yaml`, change only topology values, and use an
`address_list` containing one `/32` for the first live canary:

```sh
node bin/vpn-router.mjs validate --config ./router.yaml
./scripts/prepare-amneziawg2-artifacts.sh \
  --config ./router.yaml \
  --output-dir ./build/vpn-router
```

## AmneziaWG2 text keys

An Amnezia `vpn://` key can embed the native AWG2 profile. Extract it into a
private temporary directory without printing its contents:

```sh
umask 077
./scripts/extract-amneziawg2-profile.mjs \
  --input ./client-profile.vpn \
  --output ./private/awg0.conf
```

On a separate Linux host, the isolated validation runner uses the pinned
`amneziavpn/amneziawg-go` image, `/dev/net/tun`, and only `NET_ADMIN`/`NET_RAW`.
It checks handshake, DNS, HTTPS, transfer, host-route stability, and cleanup:

```sh
sudo ./scripts/run-isolated-amneziawg2-client.sh \
  --input ./client-profile.vpn
```

The original `.vpn` file remains the operator's responsibility and must be
removed or revoked after testing.

## Managed lifecycle

The guarded lifecycle supports an `amneziawg2_container` source with Tailscale,
external SOCKS5, or tunnel-interface egress. A host `linux_interface` source
supports external SOCKS5 or a separate tunnel interface; managed Tailscale
remains container-source-only:

```sh
sudo ./scripts/vpn-router-lifecycle.sh preflight --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh enable --config ./router.yaml --rollback-after 600
sudo ./scripts/vpn-router-lifecycle.sh status --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh verify --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh disable --config ./router.yaml
```

Installed servers use the shorter stable command:

```sh
sudo vpn-router enable --rollback-after 600
sudo vpn-router status
sudo vpn-router disable
```

`enable` always arms a server-side rollback timer. Cancel it only after the
external direct, strict, DNS, outage, and management checks pass:

```sh
sudo ./scripts/vpn-router-lifecycle.sh verify \
  --config ./router.yaml \
  --cancel-deadman
```

`disable` is the normal routing switch. It removes only project-owned routing
resources and preserves the existing VPN, external egress, and persisted
Tailscale enrollment.
The legacy `apply` and `rollback` commands remain available for automation and
recovery.

## Documentation

- [Amnezia and Tailscale quick start](docs/operations/tailscale-quickstart.md)
- [Architecture](docs/developer/architecture.md)
- [Configuration reference](docs/developer/configuration.md)
- [External SOCKS5 example](examples/config.socks5.yaml)
- [Linux tunnel egress example](examples/config.linux-interface.yaml)
- [Installation and lifecycle](docs/operations/installation.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Live validation gate](docs/operations/live-validation.md)
- [Sanitized 0.3 multi-client validation report](docs/operations/validation-report-0.3.md)
- [Sanitized 0.4 clean-host validation report](docs/operations/validation-report-0.4.md)
- [Sanitized 0.2 canary validation report](docs/operations/validation-report.md)
- [AmneziaWG2 deployment model](docs/operations/amneziawg2-sidecar.md)
- [Ownership and rollback contract](docs/operations/deployment-contract.md)

## Security

Never commit VPN profiles, private keys, Tailscale auth keys, real hostnames,
IP addresses, or raw inventory. Local operational material belongs in the
ignored `source/` directory. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
