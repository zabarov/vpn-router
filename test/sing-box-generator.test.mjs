import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.0/24' }],
  capture: { type: 'tproxy', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale', state_directory: '/var/lib/vpn-router/tailscale', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net' }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', routing_mark: 8192, routing_mask: 65535, route_table: 200, rule_priority: 12000, service_name: 'vpn-router' }
};

test('generates a no-secret TPROXY and Tailscale endpoint contract', () => {
  const generated = generateSingBoxConfig(config);
  assert.equal(generated.inbounds[0].type, 'tproxy');
  assert.equal(generated.inbounds[0].listen_port, 12345);
  assert.equal(generated.endpoints[0].type, 'tailscale');
  assert.equal(JSON.stringify(generated).includes('VPN_ROUTER_TAILSCALE_AUTH_KEY'), false);
  assert.deepEqual(generated.route.rules.at(-1), { inbound: ['capture-in'], outbound: 'direct' });
});
