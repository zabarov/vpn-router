import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { applyPreset, buildConfig, parseArgs } from '../bin/vpn-router-configure.mjs';

const configurePath = new URL('../bin/vpn-router-configure.mjs', import.meta.url);
const commandPath = new URL('../scripts/vpn-router-command.sh', import.meta.url);
const configureSource = await readFile(configurePath, 'utf8');

test('non-interactive wizard creates a private validated Tailscale canary config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-configure-'));
  const output = join(directory, 'router.yaml');
  try {
    const result = spawnSync(process.execPath, [configurePath.pathname,
      '--non-interactive',
      '--output', output,
      '--source-container', 'vpn-source',
      '--client-addresses', '10.9.0.2/32,10.9.0.3/32',
      '--exit-node', 'exit.example.ts.net',
      '--service-name', 'regional-router',
      '--nftables-table', 'regional_router'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const mode = (await stat(output)).mode & 0o777;
    assert.equal(mode, 0o600);
    const config = parse(await readFile(output, 'utf8'));
    assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
    assert.equal(config.schema_version, '2.0');
    assert.deepEqual(config.sources[0].clients.addresses, ['10.9.0.2/32', '10.9.0.3/32']);
    assert.equal(config.egresses[0].proxy_server, 'regional-router-egress');
    assert.equal(config.egresses[0].auth_key_env, 'VPN_ROUTER_TAILSCALE_AUTH_KEY');
    assert.deepEqual(config.destination_sets['strict-domains'].domain_suffixes, ['.example']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wizard refuses to overwrite a configuration unless force is explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-configure-'));
  const output = join(directory, 'router.yaml');
  const args = [configurePath.pathname, '--non-interactive', '--output', output];
  try {
    assert.equal(spawnSync(process.execPath, args).status, 0);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Refusing to overwrite existing configuration/);
    assert.equal(spawnSync(process.execPath, [...args, '--force']).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wizard renders provider-neutral external SOCKS5 and Linux source values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-configure-'));
  const output = join(directory, 'router.yaml');
  try {
    const result = spawnSync(process.execPath, [configurePath.pathname,
      '--non-interactive', '--output', output,
      '--source-type', 'linux_interface', '--source-interface', 'wg-in',
      '--client-scope', 'subnet', '--client-subnet', '10.20.0.0/24',
      '--egress-type', 'socks5', '--socks-server', 'proxy.internal', '--socks-port', '1081'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = parse(await readFile(output, 'utf8'));
    assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
    assert.equal(config.sources[0].type, 'tunnel_interface');
    assert.equal(config.sources[0].namespace, 'host');
    assert.equal(config.sources[0].container_name, undefined);
    assert.deepEqual(config.sources[0].clients, { mode: 'subnet', subnet: '10.20.0.0/24' });
    assert.equal(config.egresses[0].type, 'socks5');
    assert.equal(config.egresses[0].server, 'proxy.internal');
    assert.equal(config.egresses[0].port, 1081);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wizard rejects unknown topology choices instead of silently changing adapters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-configure-'));
  try {
    for (const [option, value, message] of [
      ['--source-type', 'unknown', /source type must be one of/],
      ['--client-scope', 'all', /client scope must be one of/],
      ['--egress-type', 'unknown', /egress type must be one of/]
    ]) {
      const result = spawnSync(process.execPath, [configurePath.pathname,
        '--non-interactive', '--output', join(directory, `${option.slice(2)}.yaml`), option, value
      ], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('amnezia-tailscale preset requires explicit real topology in non-interactive mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-configure-'));
  const output = join(directory, 'router.yaml');
  try {
    const missingCanary = spawnSync(process.execPath, [configurePath.pathname,
      '--non-interactive', '--preset', 'amnezia-tailscale', '--output', output,
      '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
      '--exit-node', 'exit.example.ts.net'
    ], { encoding: 'utf8' });
    assert.notEqual(missingCanary.status, 0);
    assert.match(missingCanary.stderr, /requires a real canary \/32/);

    const missingExit = spawnSync(process.execPath, [configurePath.pathname,
      '--non-interactive', '--preset', 'amnezia-tailscale', '--output', output,
      '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
      '--client-addresses', '10.8.1.9/32'
    ], { encoding: 'utf8' });
    assert.notEqual(missingExit.status, 0);
    assert.match(missingExit.stderr, /requires --exit-node/);

    const result = spawnSync(process.execPath, [configurePath.pathname,
      '--non-interactive', '--preset', 'amnezia-tailscale', '--output', output,
      '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
      '--client-addresses', '10.8.1.9/32', '--exit-node', 'exit.example.ts.net',
      '--domains', '.service.example'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = parse(await readFile(output, 'utf8'));
    assert.equal(config.sources[0].container_name, 'amnezia-awg');
    assert.deepEqual(config.sources[0].clients.addresses, ['10.8.1.9/32']);
    assert.equal(config.egresses[0].type, 'tailscale_socks');
    assert.deepEqual(config.destination_sets['strict-domains'].domain_suffixes, ['.service.example']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-interactive Amnezia preset requires an operator-supplied domain policy', () => {
  const result = spawnSync(process.execPath, [configurePath.pathname,
    '--non-interactive', '--preset', 'amnezia-tailscale',
    '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
    '--client-addresses', '10.8.1.9/32', '--exit-node', 'exit.example.ts.net'
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --domains/);
});

test('amnezia-tailscale preset auto-selects one discovered source and one canary', async () => {
  const values = parseArgs(['--preset', 'amnezia-tailscale', '--exit-node', 'exit.example.ts.net']);
  const configured = await applyPreset(values, async () => [{
    container_name: 'discovered-amnezia',
    interface: 'awg7',
    client_subnet: '10.44.0.0/24',
    client_addresses: ['10.44.0.3/32', '10.44.0.8/32']
  }]);
  assert.equal(configured.sourceContainer, 'discovered-amnezia');
  assert.equal(configured.sourceInterface, 'awg7');
  assert.equal(configured.clientSubnet, '10.44.0.0/24');
  assert.equal(configured.clientAddresses, '10.44.0.3/32');
});

test('amnezia-tailscale preset permits an explicit subnet only after canary rollout', async () => {
  const values = parseArgs([
    '--non-interactive', '--preset', 'amnezia-tailscale',
    '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
    '--client-scope', 'subnet', '--client-subnet', '10.8.1.0/24',
    '--exit-node', 'exit.example.ts.net', '--domains', '.service.example'
  ]);
  const configured = await applyPreset(values, async () => {
    throw new Error('discovery must not run for explicit topology');
  });
  assert.equal(configured.clientScope, 'subnet');
  assert.equal(configured.clientSubnet, '10.8.1.0/24');
});

test('all-clients shortcut uses the subnet discovered from Amnezia', async () => {
  const values = parseArgs(['--preset', 'amnezia-tailscale', '--all-clients', '--exit-node', 'exit.example.ts.net']);
  const configured = await applyPreset(values, async () => [{
    container_name: 'amnezia-awg',
    interface: 'awg0',
    client_subnet: '10.77.0.0/24',
    client_addresses: []
  }]);
  assert.equal(configured.clientScope, 'subnet');
  assert.equal(configured.clientSubnet, '10.77.0.0/24');
});

test('preset selects all discovered tunnel and proxy sources in one schema 2 configuration', async () => {
  const values = parseArgs(['--preset', 'amnezia-tailscale', '--all-clients', '--exit-node', 'exit.example.ts.net', '--domains', '.service.example']);
  const configured = await applyPreset(values, async () => [{
    source_type: 'tunnel_interface', namespace: 'container', container_name: 'amnezia-awg', interface: 'awg0',
    client_subnet: '10.77.0.0/24', client_addresses: ['10.77.0.2/32']
  }, {
    source_type: 'container_egress', container_name: 'amnezia-xray', clients: { mode: 'all' }
  }]);
  const config = buildConfig(configured);
  assert.equal(config.schema_version, '2.0');
  assert.deepEqual(config.sources.map((source) => source.type), ['tunnel_interface', 'container_egress']);
  assert.deepEqual(config.policies[0].sources, ['tunnel-1', 'proxy-2']);
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
});

test('preset rejects partial explicit selection and a discovered tunnel without a canary', async () => {
  await assert.rejects(
    applyPreset(parseArgs(['--preset', 'amnezia-tailscale', '--source-container', 'amnezia-awg']), async () => []),
    /requires both --source-container and --source-interface/
  );
  await assert.rejects(
    applyPreset(parseArgs(['--preset', 'amnezia-tailscale', '--exit-node', 'exit.example.ts.net']), async () => [{
      source_type: 'tunnel_interface', namespace: 'container', container_name: 'amnezia-awg', interface: 'awg0',
      client_subnet: '10.77.0.0/24', client_addresses: []
    }]),
    /no configured VPN client \/32/
  );
});

test('setup shortcut creates an Amnezia and Tailscale config through the guarded preset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-setup-'));
  const output = join(directory, 'router.yaml');
  try {
    const result = spawnSync(commandPath.pathname, [
      'setup', '--non-interactive', '--output', output,
      '--source-container', 'amnezia-awg', '--source-interface', 'awg0',
      '--client-addresses', '10.8.1.7/32',
      '--exit-node', 'exit.example.ts.net',
      '--domains', '.service.example,.corp.example'
    ], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const config = parse(await readFile(output, 'utf8'));
    assert.equal(config.egresses[0].exit_node, 'exit.example.ts.net');
    assert.deepEqual(config.destination_sets['strict-domains'].domain_suffixes, ['.service.example', '.corp.example']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interactive beginner preset asks only user-owned routing choices', () => {
  const start = configureSource.indexOf('async function collectPresetInteractive');
  const end = configureSource.indexOf('function commaList', start);
  const presetWizard = configureSource.slice(start, end);
  assert.match(presetWizard, /Tailscale exit node name or IP/);
  assert.match(presetWizard, /Domain suffixes routed through Tailscale/);
  assert.match(presetWizard, /askRequired\(rl, 'Domain suffixes routed through Tailscale'/);
  assert.doesNotMatch(presetWizard, /VPN source type|Owned nftables table|Service name/);
});
