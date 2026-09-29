# Experimental UDP telephony canary

This is an opt-in test procedure, not a promise that a SIP account or audio
stream will work. VPN Router's established path handles selected TCP through
SOCKS. A SIP softphone often sends UDP signaling and RTP media, which that path
cannot carry. The UDP option uses the same managed Tailscale exit node through
its kernel TUN interface. It supports one containerized tunnel source and an
explicit client address list; XRay/container-egress and generic SOCKS5 are not
supported by this option.

## Prepare

1. Install and test the source VPN normally. Keep a second, excluded VPN client
   available as a control. Record the source's actual tunnel interface, client
   `/32`, and baseline routes without copying private VPN configuration to Git.
2. Confirm that the selected Tailscale node is online, is authorized as an exit
   node, and actually carries UDP. The managed egress container requires
   `/dev/net/tun`, `NET_ADMIN`, and the host's Docker networking features.
3. Obtain signaling and media destination ranges and ports from the provider.
   A registrar DNS answer does not prove the RTP destination range. For
   example, Novofon's [published network guidance](https://novofon.com/blog/problemy-ip-telephonii/)
   lists `37.139.38.0/24`, signaling UDP 5060, and RTP UDP 10000–50000;
   recheck the provider before using those values. A softphone may also use
   STUN (often UDP 3478) and may advertise private SDP addresses. Neither
   the router nor this guide rewrites SIP/SDP.
4. Make a root-only copy of the active configuration and preserve the existing
   manifest and release. Do not edit an applied configuration in place.

## Configure one client

Start from [`examples/config.sip-udp.yaml`](../../examples/config.sip-udp.yaml),
replacing *all* example source, egress, client, and provider values. Add
`udp_clients` as a single `/32` within the source's normal `clients` scope.
Add a dedicated strict destination set for the provider's verified network,
and select only its required UDP ports. UDP/443 is intentionally forbidden.
The configuration must retain the strict `failure_mode: block` policy and the
default-direct policy.

For a new private configuration, `vpn-router setup` also accepts an explicit
advanced UDP option group. All four options are required together; no provider
range or port is inferred from a SIP hostname:

```sh
sudo vpn-router setup --non-interactive \
  --source-container example-vpn --source-interface wg0 \
  --all-clients --client-subnet 10.42.0.0/24 \
  --exit-node exit-node.example.ts.net --countries RU \
  --udp-source-container example-vpn \
  --udp-client-addresses 10.42.0.2/32 \
  --udp-destination-cidrs 198.51.100.0/24 \
  --udp-destination-ports 5060,10000-50000
```

These are documentation-only addresses. Replace them with the discovered VPN
source, a real canary `/32`, and provider-verified media destinations. The
normal source client scope may cover the pool, but UDP remains limited to the
explicit `udp_clients` list. For an already deployed router, prepare a new
private configuration and validate it; do not run `setup --force` against an
applied file. After acceptance, the ordinary `enable` and `disable` commands
turn both TCP and UDP routing on or off as one transaction. Disabling never
stops the source VPN or deletes the Tailscale enrollment.

```sh
sudo vpn-router disable --config /etc/vpn-router/router.yaml
# Edit the private configuration, mode 0600, using your preferred editor.
sudo vpn-router validate --config /etc/vpn-router/router.yaml
sudo vpn-router doctor --config /etc/vpn-router/router.yaml
sudo vpn-router enable --config /etc/vpn-router/router.yaml --rollback-after 600
```

The `disable`/`enable` transition recreates the project-owned Tailscale
container, so selected TCP connections can briefly disconnect. The source
Amnezia container and its default route must remain unchanged. Do not cancel
the independent rollback timer before the tests below.
If verification reports `udp_link=FAIL:<component>`, stop the canary and use
the root-only failure evidence under `/var/lib/vpn-router/runtime/failures/`.
Do not broaden the client or UDP-port scope to work around a missing return
route. Selected UDP is rejected until both the source guard and return path
are healthy.

## Accept or revert

Check, in order:

1. The canary still opens an ordinary non-selected site through the normal VPN
   server exit. The excluded control client is unchanged.
2. A selected web destination still uses the configured Tailscale exit.
3. The softphone registers while connected to the VPN. Place and receive a
   short call; verify **two-way audio**, not only registration. Inspect
   project-owned nftables counters for both signaling and media. No capture
   should expose account credentials or call content.
4. Stop the selected exit or its link briefly: the canary's selected UDP must
   fail, never use the source VPN's direct internet connection. Ordinary
   non-selected traffic must keep working. Restore the exit and repeat the
   registration/call check.
5. Confirm the source and SSH default routes, excluded client, and original VPN
   containers are unchanged. Run `sudo vpn-router verify --config
   /etc/vpn-router/router.yaml --cancel-deadman` only after every check passes.

If any check fails, immediately use `sudo vpn-router disable --config
/etc/vpn-router/router.yaml`, restore the saved configuration, and re-enable
the previously accepted TCP-only runtime with a new rollback timer. An
unanswered call, one-way audio, direct leak, missing rollback, or host-route
change is a failed canary. SIP ALG, NAT keepalive, STUN, codec, and provider
firewall settings may need separate diagnosis; do not widen the entire VPN
pool to compensate for one failed account.

## Current limits

- IPv4 only; no broad UDP or QUIC passthrough.
- One containerized tunnel source, one Tailscale exit, explicitly listed client
  addresses and destination ports.
- Provider media can use different IPs than the registrar. Update the
  provider-specific set only from trustworthy evidence.
- The UDP path does not interpret SIP/SDP, authenticate calls, or guarantee
  NAT traversal. A real two-way call is the acceptance test.
- One guarded live canary has passed registration, incoming and outgoing calls,
  and two-way audio. This is not proof for every provider or every VPN client;
  live exit-failure, excluded-client, and reboot/recreation checks remain open.
