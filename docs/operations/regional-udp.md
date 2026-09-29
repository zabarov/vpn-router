# Regional UDP routing for a VPN subnet

This experimental mode sends TCP and every UDP port for **selected IPv4
destinations** through the same managed Tailscale exit. Ordinary destinations
continue to use the VPN server's direct Internet connection. It does not turn
the VPN into a full-tunnel Tailscale exit for all destinations.

This mode works for one containerized tunnel source such as AmneziaWG. It does
not yet forward UDP from XRay/container-egress, external SOCKS5, or a generic
Linux-interface egress. IPv6 remains unsupported. A first rollout should use
one canary `/32`; expand to the VPN subnet only after a second-client and
fail-closed test.

## Prepare a private configuration

Install and verify the VPN and its clients first. Discover the actual source
container, tunnel interface, and VPN client subnet. Verify the chosen Tailscale
exit node independently. The values below are examples, not live addresses:

```sh
sudo vpn-router setup --non-interactive \
  --source-container example-vpn --source-interface wg0 \
  --all-clients --client-subnet 10.42.0.0/24 \
  --exit-node exit-node.example.ts.net --countries RU \
  --udp-source-container example-vpn \
  --udp-client-subnet 10.42.0.0/24 \
  --udp-destination-ports all
```

This creates a private file; it does not enable routing. For the first test,
use `--udp-client-addresses 10.42.0.2/32` instead of `--udp-client-subnet`.
The UDP subnet must be inside the source's normal client scope. `all` includes
UDP/443 (QUIC). Omitting `--udp-destination-cidrs` reuses the same selected
country, exact-domain, suffix, and static-IP sets as TCP. To route an
additional provider range, add verified CIDRs explicitly; do not assume all
telephony media IPs belong to a chosen country.

The [generic example](../../examples/config.regional-udp.yaml) uses a
documentation-only IP range so it can be validated without a data provider.
The [narrow SIP example](../../examples/config.sip-udp.yaml) remains valid.

## Enable and verify

Before replacing an active configuration, keep a root-only copy of that file,
the current release, manifest, nftables tables, policy rules, and routes. Use
the normal `disable`/`enable` transition with an independent server-side
rollback timer. Enabling the TUN mode can briefly recreate the managed
Tailscale egress and interrupt selected TCP connections. The source VPN
container and host default route must not change.

Verify on a canary and then an independent second client:

1. A selected country/domain/IP destination uses the chosen exit for TCP and
   UDP, including UDP/443 and a non-telephony UDP port.
2. An unselected destination stays on the ordinary VPN-server exit.
3. Incoming and outgoing application traffic works where relevant, including
   two-way audio for calls. Registration alone is insufficient.
4. Stopping the selected exit blocks selected UDP without any direct fallback;
   unselected traffic and SSH stay available.
5. Restarting/recreating the egress and source containers restores only
   project-owned resources. `disable` removes the UDP path while preserving
   the VPN and Tailscale enrollment.

Only cancel the rollback timer after these checks pass. The normal
`vpn-router enable` and `vpn-router disable` commands then operate both TCP
and UDP routing together. Do not describe a successful one-client call as
proof for an entire VPN pool or every third-party application.

## Classification limits

Country ranges describe network resource registration, not guaranteed physical
location. Exact-domain IPs may be shared with unrelated sites; suffixes still
depend on managed DNS observation and can be bypassed by client DoH or cache.
Applications using destinations outside the selected sets continue through the
VPN server directly. An explicit full-Internet exit is a different policy and
is not enabled by this mode.
