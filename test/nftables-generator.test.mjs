import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNftablesConfig } from '../src/nftables-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.0/24' }],
  capture: { type: 'tproxy', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055 }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { domain_suffixes: ['.ru', '.xn--p1ai', '.su'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', routing_mark: 8192, routing_mask: 65535, route_table: 200, rule_priority: 12000, service_name: 'vpn-router' }
};

test('captures strict domain policies by TLS or HTTP name, not only DNS', () => {
  const generated = generateNftablesConfig(config);
  assert.match(generated, /table inet vpn_router/);
  assert.match(generated, /set set_regional_services \{ type ipv4_addr; flags interval; \}/);
  assert.match(generated, /iifname "awg0" udp dport 53 redirect to :5353/);
  assert.match(generated, /iifname "awg0" meta l4proto tcp tproxy ip to :12345 meta mark set 8192 accept/);
  assert.match(generated, /iifname "awg0" udp dport 443 reject/);
  assert.match(generated, /iifname "awg0" ip6 daddr ::\/0 reject/);
  assert.doesNotMatch(generated, /flush ruleset/);
});
