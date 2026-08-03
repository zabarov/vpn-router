import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.2/32' }],
  capture: { type: 'redirect', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055, healthcheck_url: 'https://example.com/' }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', service_name: 'vpn-router' }
};

test('generates a redirect and isolated Tailscale SOCKS egress contract', () => {
  const generated = generateSingBoxConfig(config);
  assert.equal(generated.inbounds[0].type, 'redirect');
  assert.equal(generated.inbounds[0].listen_port, 12345);
  assert.deepEqual(generated.dns, {
    servers: [{ type: 'local', tag: 'container-dns', prefer_go: true }],
    final: 'container-dns',
    strategy: 'ipv4_only',
    disable_cache: true
  });
  assert.deepEqual(generated.outbounds.find((outbound) => outbound.tag === 'regional-exit'), {
    type: 'socks',
    tag: 'regional-exit',
    server: 'vpn-router-egress',
    server_port: 1055,
    domain_resolver: { server: 'container-dns', strategy: 'ipv4_only' }
  });
  assert.doesNotMatch(JSON.stringify(generated), /VPN_ROUTER_TAILSCALE_AUTH_KEY|exit_node/);
  assert.deepEqual(generated.route.rules, [{ inbound: ['capture-in'], outbound: 'regional-exit' }]);
  assert.equal(generated.route.final, 'regional-exit');
  assert.equal(generated.outbounds.some((outbound) => outbound.type === 'direct' || outbound.type === 'block'), false);
});

test('does not reclassify traffic already selected by managed DNS', () => {
  const domainConfig = structuredClone(config);
  domainConfig.destination_sets['regional-services'] = { domain_suffixes: ['.ru', '.xn--p1ai', '.su'] };
  const generated = generateSingBoxConfig(domainConfig);
  assert.deepEqual(generated.route.rules, [{ inbound: ['capture-in'], outbound: 'regional-exit' }]);
  assert.doesNotMatch(JSON.stringify(generated), /sniff|domain_suffix|ip_cidr/);
});
