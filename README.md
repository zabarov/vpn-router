# VPN Router

VPN Router applies one strict, domain-oriented routing policy to traffic that
arrives through a VPN. Selected IPv4/TCP destinations leave through an isolated
Tailscale SOCKS5 exit; all other traffic keeps the VPN server's normal direct
egress.

```text
VPN client -> VPN interface -> managed DNS/IP set -> TCP REDIRECT -> sing-box
                                                            -> Tailscale SOCKS -> exit node
                     non-selected traffic --------------------------> direct
```

The policy model is provider-neutral. `linux_interface` represents a VPN
interface in the current Linux namespace, and `amneziawg2_container` is the
first managed deployment adapter. The routing core does not contain country or
provider names.

> Status: `0.2.0-pre-alpha`. The generator, secret-safe AmneziaWG2 profile
> extraction, source-scoped fail-closed rules, disposable integration lab, and
> guarded AmneziaWG2 lifecycle are implemented. Every live deployment still
> requires a `/32` canary, a backup, a rollback deadman, and operator-reviewed
> acceptance evidence. This release is not production-ready.

## Current guarantee

The pre-alpha contract intentionally stays narrow:

- one active IPv4 source client, expressed as `/32`;
- one strict destination policy and one `default -> direct` policy;
- managed plain DNS for domain suffixes;
- TCP capture only;
- selected UDP and QUIC rejection;
- no IPv6 route claim;
- no direct fallback when sing-box or the Tailscale SOCKS egress is unavailable.

The example regional profile contains `.ru`, `.xn--p1ai`, and `.su`. It is only
a suffix list. Services hosted on `.com`, `.net`, shared CDNs, or direct IPs
must be added deliberately and can have shared-IP side effects.

Chrome Secure DNS, other DoH/DoT clients, ECH, direct-IP connections, and IPv6
are outside the guaranteed mode. Use system DNS and disable those alternate
paths for a strict canary.

## Quick start

Requires Node.js 22 or newer and Docker for container checks.

```sh
npm ci
npm test
npm run validate
./lab/redirect/verify.sh
```

Copy `config.example.yaml`, change only public topology values, and keep the
first client scope at `/32`:

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

The guarded lifecycle currently applies only to `amneziawg2_container`:

```sh
sudo ./scripts/vpn-router-lifecycle.sh preflight --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh apply --config ./router.yaml --rollback-after 600
sudo ./scripts/vpn-router-lifecycle.sh status --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh verify --config ./router.yaml
sudo ./scripts/vpn-router-lifecycle.sh rollback --config ./router.yaml
```

`apply` always arms a server-side rollback timer. Cancel it only after the
external direct, strict, DNS, outage, and management checks pass:

```sh
sudo ./scripts/vpn-router-lifecycle.sh verify \
  --config ./router.yaml \
  --cancel-deadman
```

## Documentation

- [Architecture](docs/developer/architecture.md)
- [Configuration reference](docs/developer/configuration.md)
- [Installation and lifecycle](docs/operations/installation.md)
- [Live validation gate](docs/operations/live-validation.md)
- [Sanitized pre-alpha validation report](docs/operations/validation-report.md)
- [AmneziaWG2 deployment model](docs/operations/amneziawg2-sidecar.md)
- [Ownership and rollback contract](docs/operations/deployment-contract.md)

## Security

Never commit VPN profiles, private keys, Tailscale auth keys, real hostnames,
IP addresses, or raw inventory. Local operational material belongs in the
ignored `source/` directory. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
