import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config-validator.mjs';

function validConfig() {
  return {
    schema_version: '1.0',
    sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.0/24' }],
    capture: { type: 'tproxy', listen_port: 12345 },
    egresses: [
      { tag: 'direct', type: 'direct' },
      { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055 }
    ],
    destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'] } },
    policies: [
      { tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' },
      { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }
    ],
    traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
    resources: { nftables_table: 'vpn_router', routing_mark: 8192, routing_mask: 65535, route_table: 200, rule_priority: 12000, service_name: 'vpn-router' }
  };
}

test('accepts the safe reference topology', () => {
  assert.deepEqual(validateConfig(validConfig()), { valid: true, errors: [] });
});

test('rejects a strict direct fallback', () => {
  const config = validConfig();
  config.policies[0].egress = 'direct';
  assert.match(validateConfig(config).errors.join('\n'), /cannot use direct egress/);
});

test('rejects bypass behavior in a strict profile', () => {
  const config = validConfig();
  config.traffic_handling.ipv6 = 'bypass';
  assert.match(validateConfig(config).errors.join('\n'), /cannot use bypass/);
});

test('rejects a Tailscale credential value in configuration', () => {
  const config = validConfig();
  config.egresses[1].auth_key_env = 'not-an-environment-variable';
  assert.match(validateConfig(config).errors.join('\n'), /requires auth_key_env/);
});

test('rejects a policy with an unowned destination set', () => {
  const config = validConfig();
  config.policies[0].destination_sets = ['missing-set'];
  assert.match(validateConfig(config).errors.join('\n'), /unknown destination set/);
});
