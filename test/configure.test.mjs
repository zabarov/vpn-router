import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';

const configurePath = new URL('../bin/vpn-router-configure.mjs', import.meta.url);

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
    assert.deepEqual(config.sources[0].client_scope.addresses, ['10.9.0.2/32', '10.9.0.3/32']);
    assert.equal(config.egresses[0].proxy_server, 'regional-router-egress');
    assert.equal(config.egresses[0].auth_key_env, 'VPN_ROUTER_TAILSCALE_AUTH_KEY');
    assert.deepEqual(config.destination_sets['strict-domains'].domain_suffixes, ['.ru', '.xn--p1ai', '.su']);
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
    assert.equal(config.sources[0].type, 'linux_interface');
    assert.equal(config.sources[0].container_name, undefined);
    assert.deepEqual(config.sources[0].client_scope, { mode: 'subnet', subnet: '10.20.0.0/24' });
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
