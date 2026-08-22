# VPN Router

VPN Router adds policy-based egress routing on top of VPN software that is
already running on a Linux server. It can apply one policy simultaneously to
AmneziaWG2, WireGuard/OpenVPN-style tunnel interfaces, and XRay/V2Ray proxy
containers.

```text
VPN users -> existing VPN sources -> server-maintained IP sets -> selected egress
                                      unmatched traffic -> normal server exit
```

It does not install, replace, edit, or restart Amnezia or XRay. Install Amnezia
normally with the AmneziaVPN application first; VPN Router discovers the
containers and adds separately owned routing resources.

Status: `0.6.0-alpha.1` candidate. Country CIDRs, pre-resolved exact domains,
static CIDRs, and managed-DNS suffix observation are implemented with
last-known-good data and fail-closed behavior. The candidate is not stable or
production-ready; a second live VPN-host acceptance and the documented
beta/stable observation gates still apply.

## Supported topology

One installation can select all supported sources:

- `tunnel_interface`: AmneziaWG2, WireGuard, OpenVPN, or another TUN/TAP
  interface in the host or a container namespace;
- `container_egress`: XRay/V2Ray or another explicitly selected proxy
  container. The policy covers every user of that container because the
  original VPN client address is no longer available at its outbound socket.

Selected countries, domains, or IP ranges can leave through:

- an isolated Tailscale userspace SOCKS exit;
- an externally managed SOCKS5 server;
- an externally managed Linux network interface.

All selected sources share one policy, one strict egress, and one master
`enable`/`disable` switch. Unselected traffic keeps each VPN source's existing
direct path. If capture or the strict egress fails, selected traffic is blocked
instead of falling back directly.

## Quick start

Requirements: a Debian/Ubuntu VPN server, root access, Docker, and at least one
already working supported VPN source.

```sh
git clone https://github.com/zabarov/vpn-router.git
cd vpn-router
sudo ./install.sh install --install-dependencies
sudo vpn-router discover
sudo vpn-router setup
```

`setup` discovers all supported Amnezia tunnel and XRay containers and asks for
the Tailscale exit, countries, exact domains, suffixes, and direct overrides.
It writes a private schema-version-3 configuration but changes no routing.

For first Tailscale enrollment, enter a one-off key without saving it to shell
history or YAML:

```sh
IFS= read -r -s VPN_ROUTER_TAILSCALE_AUTH_KEY
export VPN_ROUTER_TAILSCALE_AUTH_KEY
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY vpn-router doctor
sudo --preserve-env=VPN_ROUTER_TAILSCALE_AUTH_KEY \
  vpn-router enable --rollback-after 600
unset VPN_ROUTER_TAILSCALE_AUTH_KEY
```

Confirm direct, selected-domain, DNS, and outage behavior before cancelling the
server-side rollback timer:

```sh
sudo vpn-router verify --cancel-deadman
```

The everyday routing switch is:

```sh
sudo vpn-router disable
sudo vpn-router enable --rollback-after 600
sudo vpn-router status
sudo vpn-router status --json
sudo vpn-router data-status
sudo vpn-router diagnose obr.site
```

Disabling routing preserves the source VPN containers and Tailscale enrollment.
After acceptance, `sudo vpn-router service-enable` enables boot reconciliation
and periodic recovery. `service-disable` stops recovery before disabling the
runtime, and a manually disabled runtime is never re-enabled by the watchdog.

## Safety boundary

The supported alpha mode is IPv4/TCP. Country CIDRs, static CIDRs, and
server-resolved exact domains do not depend on the client's DNS. Selected UDP
and QUIC are rejected, and IPv6 is rejected for proxy-container sources or
refused during tunnel preflight. Arbitrary suffix matching still depends on
managed plain DNS, so browser DoH/DoT, ECH, and private resolvers make suffix
routing best effort. Shared-CDN IPs can route neighboring names through the
same egress.

Country data comes from RIPEstat and represents registered Internet resources,
not guaranteed physical location. Use punycode for internationalized names and
add service-specific exceptions deliberately.

## Configuration and compatibility

The public example is [`config.example.yaml`](config.example.yaml). Existing
schema-version-1 and version-2 files remain readable and can be migrated without overwriting
the original:

```sh
vpn-router migrate-config --input old.yaml --output new.yaml
```

No credentials belong in configuration or Git. Private profiles, inventory,
and operational evidence belong under the ignored `source/` directory.

## Documentation

- [Simple Amnezia and Tailscale setup](docs/operations/tailscale-quickstart.md)
- [Installation and lifecycle](docs/operations/installation.md)
- [Configuration reference](docs/developer/configuration.md)
- [Architecture](docs/developer/architecture.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Sanitized 0.5 validation report](docs/operations/validation-report-0.5.md)
- [Production contract](docs/developer/production-contract.md)
- [Security policy](SECURITY.md)
- [Responsible use](RESPONSIBLE_USE.md)

## Contributor checks

Requires Node.js 22 or newer and Docker:

```sh
npm ci
npm run check
npm run check:containers
npm run check:clean-host
```

Maintainers build a secret-safe archive only from a clean committed tree:

```sh
npm run build:release
```

The builder uses Git's tracked-file archive, refuses untracked public files,
and rejects private `.env` paths before writing the checksum.

## License

MIT. See [LICENSE](LICENSE).
