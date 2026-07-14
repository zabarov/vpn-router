# VPN Router

VPN Router is a provider-neutral, policy-based router for traffic that arrives
through a VPN and must leave through a selected egress path.

Its first target topology is:

```text
VPN client -> AmneziaWG 2 container -> VPN Router sidecar -> isolated SOCKS5 proxy -> Tailscale exit node
```

The router is deliberately adapter-based. AmneziaWG 2 and a generic Linux
network interface are the initial traffic source adapters, while Tailscale is
the first egress adapter; none is baked into the core policy model. The
Tailscale adapter is intentionally isolated from the VPN container namespace so
an exit-node route cannot replace the VPN's own default route.

> Status: pre-alpha. This repository currently provides the configuration
> contract, examples, and local validation tooling. It does not yet install or
> modify a server.

## What it is for

- Route selected destinations through a chosen egress, such as a Tailscale exit
  node.
- Keep all other traffic on a direct path.
- Block selected traffic when its strict egress is unavailable instead of
  silently leaking it through the direct path.
- Support VPN implementations whose client interface exists inside a container
  network namespace.

## Design principles

- **Adapter-based:** traffic sources and egresses are explicit adapters.
- **Pre-NAT capture:** an AmneziaWG 2 adapter must observe `awg0` inside the
  Amnezia container namespace, before its NAT rules rewrite the client source.
- **Fail closed:** a policy marked `block` never falls back to direct egress.
- **Owned resources:** routing marks, route tables, nftables tables, state
  directories, and service names are configured rather than assumed.
- **No secrets in config:** reference credentials only through environment
  variable names or local secret files ignored by Git.

## Quick start

Requires Node.js 22 or newer.

```sh
npm install
npm test
npm run validate
```

`config.example.yaml` is safe to copy and adapt. Validate a local file before
using it:

```sh
node bin/vpn-router.mjs validate --config ./router.yaml
```

## Documentation

- [Architecture](docs/developer/architecture.md)
- [Configuration reference](docs/developer/configuration.md)
- [Installation and safety boundaries](docs/operations/installation.md)
- [Live validation gate](docs/operations/live-validation.md)
- [AmneziaWG 2 sidecar deployment model](docs/operations/amneziawg2-sidecar.md)
- [Deployment contract and rollback boundary](docs/operations/deployment-contract.md)
- [Documentation map](docs/README.md)

## Scope and non-goals

The initial release is not a generic VPN server installer, a Tailscale control
plane, or a promise that arbitrary VPN providers work without an adapter. It
does not change host firewall, routes, Docker, DNS, or Tailnet state merely by
running the validator.

## Security

Do not commit private keys, Tailscale auth keys, VPN configurations, hostnames,
or inventory output. Report security issues using
[SECURITY.md](SECURITY.md).

## License

This project is licensed under the [MIT License](LICENSE).
