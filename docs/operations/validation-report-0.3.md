# 0.3.0-pre-alpha validation report

This report records sanitized evidence from the 2026-08-03 multi-client and
whole-pool reference rollout. It excludes server addresses, client addresses,
hostnames, credentials, peer keys, private configuration, and raw logs.

The result validates one reference deployment. It does not make an arbitrary
host production-ready without repeating the documented gates.

## Repository and disposable evidence

- 56 unit, schema, generator, lifecycle-contract, repository and security tests
  passed.
- Shell, English-only and secret checks passed.
- The namespace lab proved pre-NAT source capture and complete cleanup.
- The external-SOCKS5 redirect lab proved two selected clients and one excluded
  control client.
- The same lab proved explicit whole-subnet selection and restoration to a
  staged address list.
- SOCKS and capture outages blocked selected traffic while direct traffic
  remained healthy; both components recovered.
- Complete provider-neutral examples for external SOCKS5 and Linux-interface
  egresses passed JSON Schema and semantic validation.

## Live staged rollout

The previous single-client release was preserved. Before mutation, the
operator captured a root-only baseline with a verified checksum manifest and
confirmed that persistent and runtime peer inventories matched.

The release was then rolled out in two independent transactions:

1. an exact address list containing every existing VPN peer;
2. the explicit VPN client subnet, allowing current and future users in that
   pool to receive the same policy.

Each transaction armed a server-side ten-minute rollback deadman before its
first network mutation. The list stage was disabled successfully before the
subnet stage, proving the routing switch without stopping the source VPN.

Both stages passed:

- lifecycle `status` and `verify`;
- working-client VPN address and ordinary HTTPS;
- direct identity through the normal VPN server egress;
- strict REDIRECT counter growth for a selected suffix;
- different direct and strict egress identities;
- managed DNS set population;
- Tailscale-down strict block, direct continuity and recovery;
- sing-box-down strict block, direct continuity and recovery;
- unchanged persistent/runtime peer counts and no duplicate or out-of-pool
  peer address;
- unchanged source default-route fingerprint;
- exact release link, stored configuration and configured client scope.

The final subnet stage remained `applied`. The deadman was cancelled only after
the complete acceptance matrix passed. The existing AmneziaWG2 service, peer
configuration and persisted Tailscale enrollment were preserved.

## Remaining gates

The release remains pre-alpha. Promotion still requires fresh evidence for:

- an expired deadman executing without an operator;
- host reboot, Docker restart and source-container recreation;
- upgrade and downgrade recovery exercises;
- a bundled lifecycle for a generic host `linux_interface` source;
- integrated Linux-interface strict-egress behavior;
- IPv6, selected UDP, DoH/DoT, ECH, direct-IP and shared-CDN boundaries.
