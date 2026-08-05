import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { migrateConfig, normalizeConfig } from '../src/config-normalizer.mjs';
import { validateConfig } from '../src/config-validator.mjs';

const execFileAsync = promisify(execFile);

function legacyConfig() {
  return {
    schema_version: '1.0',
    sources: [{ tag: 'vpn-in', type: 'amneziawg2_container', container_name: 'vpn-source', interface: 'awg0', client_scope: { mode: 'subnet', subnet: '10.8.0.0/24' } }],
    capture: { type: 'redirect', listen_port: 12345 },
    egresses: [{ tag: 'direct', type: 'direct' }, { tag: 'strict', type: 'socks5', server: 'egress.example.net', port: 1080, healthcheck_url: 'https://example.com/' }],
    policies: [{ tag: 'strict', source: 'vpn-in', destination_sets: ['selected'], egress: 'strict', failure_mode: 'block' }, { tag: 'default', source: 'vpn-in', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
    destination_sets: { selected: { domain_suffixes: ['.service.example'] } },
    traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
    resources: { nftables_table: 'vpn_router', service_name: 'vpn-router' }
  };
}

test('normalizes schema 1 adapters and policy references into schema 2', () => {
  const migrated = migrateConfig(legacyConfig());
  assert.equal(migrated.schema_version, '2.0');
  assert.deepEqual(migrated.sources[0], {
    tag: 'vpn-in', type: 'tunnel_interface', namespace: 'container', container_name: 'vpn-source', interface: 'awg0', clients: { mode: 'subnet', subnet: '10.8.0.0/24' }
  });
  assert.deepEqual(migrated.policies.map((policy) => policy.sources), [['vpn-in'], ['vpn-in']]);
  assert.deepEqual(validateConfig(migrated), { valid: true, errors: [] });
  assert.deepEqual(normalizeConfig(migrated), migrated);
});

test('migrate-config writes a new private file and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-migrate-'));
  const input = join(directory, 'old.yaml');
  const output = join(directory, 'new.yaml');
  await writeFile(input, `${JSON.stringify(legacyConfig())}\n`, { mode: 0o600 });
  await execFileAsync(process.execPath, ['bin/vpn-router.mjs', 'migrate-config', '--input', input, '--output', output], { cwd: new URL('..', import.meta.url) });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(parse(await readFile(output, 'utf8')).schema_version, '2.0');
  await assert.rejects(
    execFileAsync(process.execPath, ['bin/vpn-router.mjs', 'migrate-config', '--input', input, '--output', output], { cwd: new URL('..', import.meta.url) }),
    /EEXIST/
  );
});
