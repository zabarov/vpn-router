# Production contract

## Product boundary

VPN Router applies destination policy to traffic that has already entered an
existing VPN. It does not create VPN users, distribute client profiles, replace
the VPN server, or own the VPN interface default route.

The core is provider-neutral:

- a source adapter exposes one Linux interface and an explicit client scope;
- destination sets select IPv4 addresses directly or through managed DNS;
- a strict policy sends selected TCP connections to one egress adapter;
- the default policy leaves all non-selected traffic on the existing VPN path;
- lifecycle commands own only resources named by the project manifest.

AmneziaWG2 and Tailscale are reference adapters, not core requirements.

## Client scope

Every source declares exactly one `client_scope`:

```yaml
client_scope:
  mode: address_list
  addresses:
    - 10.8.1.2/32
    - 10.8.1.3/32
```

or:

```yaml
client_scope:
  mode: subnet
  subnet: 10.8.1.0/24
```

`address_list` is the rollout mode. `subnet` is the explicit whole-instance
mode for operators who want the same policy for every VPN client. An interface-
only wildcard is forbidden because it could capture unrelated traffic after a
network-namespace or interface reuse.

The legacy `client_subnet: <IPv4 /32>` field remains readable during the
pre-alpha migration period and is normalized to a one-entry `address_list`.
New configurations must use `client_scope`; both forms together are invalid.

## Egress adapters

The first production contract defines these strict TCP egress capabilities:

| Type | Ownership | Use case |
| --- | --- | --- |
| `tailscale_socks` | managed userspace sidecar | Exit through a selected Tailscale node without changing the VPN namespace route. |
| `socks5` | external service | Exit through any reachable SOCKS5 service, including one hosted on another server. |
| `linux_interface` | pre-existing local interface | Exit through a separately managed tunnel or interface in the source namespace. |

Credentials are never configuration values. An adapter may reference an
environment variable or root-only secret file name when credential support is
implemented. Render and status commands must never emit the resolved value.

Adapters expose capabilities instead of relying on type-name assumptions:

- proxied TCP support;
- DNS ownership requirements;
- health-check method;
- managed versus external lifecycle;
- required namespace/network attachment;
- failure behavior.

The default `direct` egress is reserved for the default policy. A strict policy
always uses `failure_mode: block` and never falls back to `direct`.

## Lifecycle state model

The operator interface is:

```text
preflight -> enable -> status/verify -> disable
                         |                |
                         `---- rollback -'
```

- `enable` transactionally creates or reconciles owned runtime resources and
  requires a server-side deadman timeout.
- `disable` removes policy enforcement and sidecars while preserving the
  existing VPN, stored configuration, backups, and persistent egress state.
- `rollback` is the failure/recovery operation. It removes owned resources,
  verifies the saved network baseline, and records a rollback result.
- `status` reports configured scope, lifecycle state, adapter health, owned
  resources, and drift without printing credentials or private config.
- `verify` checks the current manifest, source identity, selected egress,
  ordinary path, strict path, and ownership boundaries.

All lifecycle commands are idempotent. `disable` followed by `enable` is the
documented routing switch. It must not disconnect VPN clients or restart the
VPN implementation.

## Failure invariants

- Selected traffic is blocked if capture, DNS selection, or strict egress is
  unavailable.
- Non-selected traffic remains on the existing VPN path during a strict-path
  outage.
- DNS-selected addresses persist until lifecycle cleanup. This prefers
  temporary over-routing of a stale/shared address to a direct leak caused by a
  longer-lived client DNS cache.
- Client scope cannot widen implicitly during configuration migration, update,
  restart, or source-container recreation.
- A changed source container identity is drift and requires a new preflight;
  the lifecycle must not clean an unknown namespace.
- Host default routes, source default routes, policy rules, and the SSH route
  must match their stable baseline after disable or rollback.

## Production acceptance

Production readiness requires more than passing unit tests. A release candidate
must prove:

1. one-client canary behavior;
2. an `address_list` with at least two clients and one excluded control client;
3. explicit `subnet` behavior for the complete test pool;
4. strict and direct identities;
5. Tailscale/SOCKS/capture/DNS outage behavior;
6. repeated enable, disable, rollback, restart, and source recreation;
7. exact ownership cleanup and baseline restoration;
8. secret-free artifacts, logs, status, repository and release package;
9. upgrade and downgrade between the previous and candidate configuration;
10. a live rollout with backup, server-side deadman rollback, stop conditions,
    and an operator-confirmed change window.

IPv6, selected UDP, DoH/DoT, ECH, direct-IP classification, and shared-CDN
precision remain outside the first production contract until they have their
own implementation and evidence.
