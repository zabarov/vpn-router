import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.0/24' }],
  capture: { type: 'tproxy', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055 }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', routing_mark: 8192, routing_mask: 65535, route_table: 200, rule_priority: 12000, service_name: 'vpn-router' }
};

test('generates a TPROXY and isolated Tailscale SOCKS egress contract', () => {
  const generated = generateSingBoxConfig(config);
  assert.equal(generated.inbounds[0].type, 'tproxy');
  assert.equal(generated.inbounds[0].listen_port, 12345);
  assert.deepEqual(generated.outbounds.find((outbound) => outbound.tag === 'regional-exit'), { type: 'socks', tag: 'regional-exit', server: 'vpn-router-egress', server_port: 1055 });
  assert.doesNotMatch(JSON.stringify(generated), /VPN_ROUTER_TAILSCALE_AUTH_KEY|exit_node/);
  assert.equal(generated.route.final, 'direct');
  assert.doesNotMatch(JSON.stringify(generated.route.rules), /"inbound":\["capture-in"\],"outbound":"block"/);
});

test('sniffs a strict domain policy before evaluating its suffix', () => {
  const domainConfig = structuredClone(config);
  domainConfig.destination_sets['regional-services'] = { domain_suffixes: ['.ru', '.xn--p1ai', '.su'] };
  const generated = generateSingBoxConfig(domainConfig);
  assert.deepEqual(generated.route.rules[0], { inbound: ['capture-in'], action: 'sniff', timeout: '1s' });
  assert.ok(generated.route.rules.some((rule) => JSON.stringify(rule) === JSON.stringify({ inbound: ['capture-in'], domain_suffix: ['.ru', '.xn--p1ai', '.su'], outbound: 'regional-exit' })));
  assert.equal(generated.route.final, 'direct');
});
