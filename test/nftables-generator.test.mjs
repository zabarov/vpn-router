import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNftablesConfig, generateNftablesDataUpdate } from '../src/nftables-generator.mjs';

const config = {
  schema_version: '1.0',
  sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_scope: { mode: 'address_list', addresses: ['10.8.1.2/32', '10.8.1.3/32'] } }],
  capture: { type: 'redirect', listen_port: 12345 },
  egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055, healthcheck_url: 'https://example.com/' }],
  policies: [{ tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' }, { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
  destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'], domain_suffixes: ['.service.example', '.corp.example'] } },
  traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
  resources: { nftables_table: 'vpn_router', service_name: 'vpn-router' }
};

test('generates an owned strict-only TCP redirect table with a forward guard', () => {
  const generated = generateNftablesConfig(config);
  assert.match(generated, /table inet vpn_router/);
  assert.match(generated, /set source_amnezia_in_clients \{ type ipv4_addr; flags interval; elements = \{ 10\.8\.1\.2\/32, 10\.8\.1\.3\/32 \} \}/);
  assert.match(generated, /set set_regional_services_static \{ type ipv4_addr; flags interval; elements = \{ 203\.0\.113\.0\/24 \} \}/);
  assert.match(generated, /set set_regional_services_dns \{ type ipv4_addr; flags interval; \}/);
  assert.doesNotMatch(generated, /set_regional_services_dns[^\n]*timeout/);
  assert.match(generated, /iifname "awg0" ip saddr @source_amnezia_in_clients udp dport 53 counter redirect to :5353/);
  assert.match(generated, /iifname "awg0" ip saddr @source_amnezia_in_clients ip daddr @set_regional_services_dns meta l4proto tcp counter redirect to :12345/);
  assert.match(generated, /chain forward_guard \{[\s\S]*ip daddr @set_regional_services_dns meta l4proto tcp counter reject with tcp reset/);
  assert.match(generated, /iifname "awg0" ip saddr @source_amnezia_in_clients ip daddr @set_regional_services_dns meta l4proto udp counter reject/);
  assert.doesNotMatch(generated, /tproxy|meta mark/);
  assert.doesNotMatch(generated, /ip6 daddr/);
  assert.doesNotMatch(generated, /flush ruleset/);

  for (const line of generated.split('\n').filter((candidate) => /redirect to| reject/.test(candidate))) {
    assert.match(line, /ip saddr @source_amnezia_in_clients/, `rule is missing the client scope: ${line}`);
  }
});

test('generates fail-closed OUTPUT capture for a proxy container without recapturing router traffic', () => {
  const multi = {
    ...structuredClone(config),
    schema_version: '2.0',
    sources: [
      { tag: 'awg', type: 'tunnel_interface', namespace: 'container', container_name: 'amnezia-awg2', interface: 'awg0', clients: { mode: 'subnet', subnet: '10.8.1.0/24' } },
      { tag: 'xray', type: 'container_egress', container_name: 'amnezia-xray', clients: { mode: 'all' } }
    ],
    policies: config.policies.map(({ source: _source, ...policy }) => ({ ...policy, sources: ['awg', 'xray'] }))
  };
  const generated = generateNftablesConfig(multi, { sourceTag: 'xray' });
  assert.match(generated, /chain capture_output/);
  assert.match(generated, /meta mark 21076 return/);
  assert.match(generated, /meta skuid 65534 return/);
  assert.match(generated, /udp dport 53 counter redirect to :5353/);
  assert.ok(generated.indexOf('udp dport 53') < generated.indexOf('ip daddr 127.0.0.0/8 return'));
  assert.match(generated, /ip daddr @set_regional_services_dns meta l4proto tcp counter redirect to :12345/);
  assert.match(generated, /chain output_guard[\s\S]*meta nfproto ipv6 counter reject/);
  assert.match(generated, /ip daddr @set_regional_services_dns meta l4proto udp counter reject/);
  assert.match(generated, /ip daddr @set_regional_services_dns meta l4proto tcp counter reject with tcp reset/);
  assert.doesNotMatch(generated, /iifname|ip saddr|source_xray_clients/);
});

test('renders hybrid server data once and gives direct overrides first priority', () => {
  const hybrid = {
    ...structuredClone(config),
    schema_version: '3.0',
    routing_data: {
      country_provider: { type: 'ripestat', refresh_interval: '24h', max_stale: '7d' },
      domain_resolver: { refresh_interval: '5m', min_ttl: 60, max_ttl: 3600, max_stale: '24h' }
    },
    policies: [
      { tag: 'always-direct', sources: ['amnezia-in'], destination_sets: ['direct-overrides'], egress: 'direct', failure_mode: 'direct' },
      { tag: 'selected', sources: ['amnezia-in'], destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' },
      { tag: 'default', sources: ['amnezia-in'], destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }
    ],
    sources: [{ tag: 'amnezia-in', type: 'tunnel_interface', namespace: 'container', container_name: 'amnezia-awg2', interface: 'awg0', clients: { mode: 'address_list', addresses: ['10.8.1.2/32'] } }],
    destination_sets: {
      'regional-services': { country_codes: ['RU'], exact_domains: ['obr.site'], domain_suffixes: ['.ru'], ip_cidrs: [] },
      'direct-overrides': { exact_domains: ['direct.example'], ip_cidrs: ['198.51.100.0/24'] }
    }
  };
  const routingData = {
    destination_sets: {
      'regional-services': { country_cidrs: ['5.8.0.0/13'], exact_ips: ['188.40.167.81'] },
      'direct-overrides': { country_cidrs: [], exact_ips: ['198.51.100.9'] }
    }
  };
  const generated = generateNftablesConfig(hybrid, { routingData });
  assert.match(generated, /set set_regional_services_country .*5\.8\.0\.0\/13/);
  assert.match(generated, /set set_regional_services_exact .*188\.40\.167\.81/);
  assert.match(generated, /set set_direct_overrides_exact .*198\.51\.100\.9/);
  const directRule = generated.indexOf('ip daddr @set_direct_overrides_exact counter return');
  const strictRule = generated.indexOf('ip daddr @set_regional_services_country meta l4proto tcp');
  assert.ok(directRule >= 0 && directRule < strictRule);
  assert.equal((generated.match(/@set_regional_services_country meta l4proto tcp counter redirect/g) ?? []).length, 1);
  const update = generateNftablesDataUpdate(hybrid, routingData);
  assert.match(update, /^flush set inet vpn_router set_regional_services_country/m);
  assert.match(update, /add element inet vpn_router set_direct_overrides_exact \{ 198\.51\.100\.9 \}/);
  assert.equal((update.match(/flush set inet vpn_router set_regional_services_country/g) ?? []).length, 1);
});

test('refuses dynamic selectors without verified routing data', () => {
  const hybrid = structuredClone(config);
  hybrid.schema_version = '3.0';
  hybrid.routing_data = { country_provider: { type: 'ripestat', refresh_interval: '24h', max_stale: '7d' } };
  hybrid.sources = [{ tag: 'amnezia-in', type: 'tunnel_interface', namespace: 'container', container_name: 'amnezia-awg2', interface: 'awg0', clients: { mode: 'address_list', addresses: ['10.8.1.2/32'] } }];
  hybrid.policies = config.policies.map(({ source: _source, ...policy }) => ({ ...policy, sources: ['amnezia-in'] }));
  hybrid.destination_sets['regional-services'] = { country_codes: ['RU'], ip_cidrs: [], domain_suffixes: [] };
  assert.throws(() => generateNftablesConfig(hybrid), /missing country prefixes/);
});
