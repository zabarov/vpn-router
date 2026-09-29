import { validateConfig } from './config-validator.mjs';
import { buildRuntimePlan } from './runtime-plan.mjs';

export const UDP_EGRESS_TABLE = 'vpn_router_udp';
export const UDP_EGRESS_INTERFACE = 'vrudp1';

export function generateUdpEgressNft(input) {
  const validation = validateConfig(input);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);
  const udp = buildRuntimePlan(input).udp_routing;
  if (!udp) throw new Error('UDP routing is not enabled');
  const ports = udp.destination_ports.join(', ');
  const clients = udp.client_cidrs.join(', ');
  return `table inet ${UDP_EGRESS_TABLE} {
  set clients { type ipv4_addr; flags interval; elements = { ${clients} } }
  chain forward_guard {
    type filter hook forward priority -50; policy accept;
    iifname "${UDP_EGRESS_INTERFACE}" ip saddr @clients meta l4proto udp udp dport { ${ports} } oifname "tailscale0" counter accept
    iifname "${UDP_EGRESS_INTERFACE}" counter reject
  }
  chain source_nat {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr @clients oifname "tailscale0" meta l4proto udp udp dport { ${ports} } counter masquerade
  }
}
`;
}
