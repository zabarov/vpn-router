import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDnsmasqConfig } from '../src/dnsmasq-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.0/24' }],
  capture: { type: 'tproxy', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale', state_directory: '/var/lib/vpn-router/tailscale', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net' }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { domain_suffixes: ['.ru', '.xn--p1ai', '.su'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', routing_mark: 8192, routing_mask: 65535, route_table: 200, rule_priority: 12000, service_name: 'vpn-router' }
};

test('generates dnsmasq nftset rules for strict domain suffixes', () => {
  const generated = generateDnsmasqConfig(config);
  assert.match(generated, /^port=5353$/m);
  assert.match(generated, /^nftset=\/ru\/xn--p1ai\/su\/4#inet#vpn_router#set_regional_services$/m);
});
