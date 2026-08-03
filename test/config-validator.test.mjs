import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config-validator.mjs';

function validConfig() {
  return {
    schema_version: '1.0',
    sources: [{ tag: 'amnezia-in', type: 'amneziawg2_container', container_name: 'amnezia-awg2', interface: 'awg0', client_subnet: '10.8.1.2/32' }],
    capture: { type: 'redirect', listen_port: 12345 },
    egresses: [
      { tag: 'direct', type: 'direct' },
      { tag: 'regional-exit', type: 'tailscale_socks', auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY', exit_node: 'regional-exit.example.ts.net', proxy_server: 'vpn-router-egress', proxy_port: 1055, healthcheck_url: 'https://example.com/' }
    ],
    destination_sets: { 'regional-services': { ip_cidrs: ['203.0.113.0/24'] } },
    policies: [
      { tag: 'selected', source: 'amnezia-in', destination_sets: ['regional-services'], egress: 'regional-exit', failure_mode: 'block' },
      { tag: 'default', source: 'amnezia-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }
    ],
    traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
    resources: { nftables_table: 'vpn_router', service_name: 'vpn-router' }
  };
}

test('accepts the safe reference topology', () => {
  assert.deepEqual(validateConfig(validConfig()), { valid: true, errors: [] });
});

test('accepts a provider-neutral Linux interface source', () => {
  const config = validConfig();
  config.sources[0] = {
    tag: 'generic-vpn',
    type: 'linux_interface',
    interface: 'wg0',
    client_subnet: '10.8.1.2/32'
  };
  config.policies.forEach((policy) => { policy.source = 'generic-vpn'; });
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
});

test('rejects the former TPROXY capture contract', () => {
  const config = validConfig();
  config.capture.type = 'tproxy';
  assert.match(validateConfig(config).errors.join('\n'), /must declare redirect/);
});

test('rejects a strict direct fallback', () => {
  const config = validConfig();
  config.policies[0].egress = 'direct';
  assert.match(validateConfig(config).errors.join('\n'), /cannot use direct egress/);
});

test('rejects bypass behavior in a strict profile', () => {
  const config = validConfig();
  config.traffic_handling.ipv6 = 'bypass';
  assert.match(validateConfig(config).errors.join('\n'), /must be reject/);
});

test('rejects a client pool instead of a single canary address', () => {
  const config = validConfig();
  config.sources[0].client_subnet = '10.8.1.0/24';
  assert.match(validateConfig(config).errors.join('\n'), /one IPv4 host \(\/32\)/);
});

test('rejects IPv6 destination CIDRs in the IPv4 MVP', () => {
  const config = validConfig();
  config.destination_sets['regional-services'].ip_cidrs = ['2001:db8::/32'];
  assert.match(validateConfig(config).errors.join('\n'), /invalid IPv4/);
});

test('rejects a non-default direct policy', () => {
  const config = validConfig();
  config.policies[0].failure_mode = 'direct';
  assert.match(validateConfig(config).errors.join('\n'), /non-default policy .* cannot use failure_mode direct/);
});

test('requires exactly one strict and one default-direct policy', () => {
  const config = validConfig();
  config.policies.push({ ...config.policies[0], tag: 'second-strict' });
  const errors = validateConfig(config).errors.join('\n');
  assert.match(errors, /exactly one strict policy and one default-direct policy/);
  assert.match(errors, /exactly one strict policy/);
});

test('requires managed DNS for strict domain policies', () => {
  const config = validConfig();
  config.destination_sets['regional-services'] = { domain_suffixes: ['.ru'] };
  config.traffic_handling.dns_mode = 'system';
  assert.match(validateConfig(config).errors.join('\n'), /strict domain policies require.*managed/);
});

test('rejects a Tailscale credential value in configuration', () => {
  const config = validConfig();
  config.egresses[1].auth_key_env = 'not-an-environment-variable';
  assert.match(validateConfig(config).errors.join('\n'), /requires auth_key_env/);
});

test('requires a credential-free HTTPS SOCKS health check', () => {
  const config = validConfig();
  config.egresses[1].healthcheck_url = 'http://user:secret@example.com/';
  assert.match(validateConfig(config).errors.join('\n'), /credential-free HTTPS healthcheck_url/);
});

test('rejects a policy with an unowned destination set', () => {
  const config = validConfig();
  config.policies[0].destination_sets = ['missing-set'];
  assert.match(validateConfig(config).errors.join('\n'), /unknown destination set/);
});

test('rejects unknown fields instead of silently accepting them', () => {
  const config = validConfig();
  config.unexpected = true;
  config.capture.mark = 100;
  assert.match(validateConfig(config).errors.join('\n'), /configuration has an unsupported field: unexpected/);
  assert.match(validateConfig(config).errors.join('\n'), /capture has an unsupported field: mark/);
});

test('rejects an unsafe destination set name before rendering nftables', () => {
  const config = validConfig();
  config.destination_sets['regional\nset injected'] = config.destination_sets['regional-services'];
  delete config.destination_sets['regional-services'];
  config.policies[0].destination_sets = ['regional\nset injected'];
  assert.match(validateConfig(config).errors.join('\n'), /destination set has an invalid name/);
});

test('rejects Tailscale-only fields on a direct egress', () => {
  const config = validConfig();
  config.egresses[0].exit_node = 'unexpected.example.ts.net';
  assert.match(validateConfig(config).errors.join('\n'), /egress direct has an unsupported field: exit_node/);
});

test('rejects container-only fields on a generic Linux source', () => {
  const config = validConfig();
  config.sources[0] = {
    tag: 'generic-vpn',
    type: 'linux_interface',
    interface: 'wg0',
    client_subnet: '10.8.1.2/32',
    container_name: 'unexpected-container'
  };
  config.policies.forEach((policy) => { policy.source = 'generic-vpn'; });
  assert.match(validateConfig(config).errors.join('\n'), /source generic-vpn has an unsupported field: container_name/);
});

test('rejects a Linux interface name that can be parsed as an option', () => {
  const config = validConfig();
  config.sources[0].interface = '-help';
  assert.match(validateConfig(config).errors.join('\n'), /valid Linux interface name/);
});

test('rejects unused extra egresses in the narrow MVP contract', () => {
  const config = validConfig();
  config.egresses.push({ tag: 'unused-direct', type: 'direct' });
  const errors = validateConfig(config).errors.join('\n');
  assert.match(errors, /exactly one direct and one tailscale_socks egress/);
  assert.match(errors, /unused-direct is not referenced/);
});

test('rejects duplicate destination entries', () => {
  const config = validConfig();
  config.destination_sets['regional-services'].ip_cidrs.push('203.0.113.0/24');
  assert.match(validateConfig(config).errors.join('\n'), /ip_cidrs must not contain duplicates/);
});
