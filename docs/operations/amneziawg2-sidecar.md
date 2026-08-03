# AmneziaWG2 adapter

## Why capture runs in the source namespace

AmneziaWG2 normally keeps `awg0` and VPN client addresses inside its Docker
container. NAT can erase the original client address before traffic reaches the
host. The DNS and sing-box sidecars therefore use
`network_mode: container:<source>` and see pre-NAT packets.

Tailscale is deliberately different: it stays in its own userspace-networking
container. The source container receives access only to a project-owned
internal SOCKS network. This avoids the unsupported design in which two VPNs
compete for one namespace's default route.

## Read-only topology check

```sh
./scripts/preflight-amneziawg2.sh \
  --container amnezia-awg2 \
  --interface awg0
```

The managed lifecycle performs stricter checks: one `/32`, no global IPv6 on
the interface, required `ip`/`nft` tools, collision-free owned resources,
available Tailscale enrollment, and a rollback deadman.

## Import-key handling

The official Amnezia `vpn://` text key can contain a nested native AWG2
configuration. `scripts/extract-amneziawg2-profile.mjs` decodes the Qt-compressed
payload, finds the native profile, verifies AWG2 `S3`/`S4` fields, removes only
empty optional `I1`-`I5` lines rejected by native tools, and creates a new
mode-`0600` file. It refuses overwrite and never prints the profile.
Profiles containing `wg-quick` command hooks or persistence directives are
rejected. The isolated runner also removes profile-supplied DNS and routing
table directives before starting the disposable namespace.

The isolated client runner uses the pinned
`amneziavpn/amneziawg-go:3.0.3` digest. It does not use host networking or
`--privileged`; only `/dev/net/tun`, `NET_ADMIN`, and `NET_RAW` are granted.

## Recreation behavior

Docker binds `network_mode: container:<name>` to one container namespace. If
the source container is recreated, lifecycle verification fails on container
ID mismatch. The old namespace and its rules disappear; do not apply anything
to the new namespace until preflight, baseline, and canary are repeated.

## Validation status

The disposable lab proves source `/32` matching, managed-DNS first-attempt
selection, TCP-redirect and SOCKS dependency, fail-closed behavior for both
outages, direct-path continuity, out-of-scope-client isolation, selected-address
persistence after managed DNS stops, and full cleanup. Native Linux and live canary results must still be recorded
for each deployment; no generic lab result makes a host production-ready.

## Upstream references

- [Amnezia text-key import](https://docs.amnezia.org/documentation/instructions/connect-via-text-key/)
- [AmneziaWG protocol parameters](https://docs.amnezia.org/documentation/amnezia-wg/)
- [amneziawg-go releases](https://github.com/amnezia-vpn/amneziawg-go/releases)
