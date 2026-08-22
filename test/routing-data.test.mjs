import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';
import { assessRoutingDataState, buildRoutingDataState, canonicalIpv4Cidr, normalizeIpv4Cidrs, readRoutingDataState, writeRoutingDataState } from '../src/routing-data.mjs';
import { collectRuntimeDiagnostics, summarizeNftCounters } from '../src/runtime-diagnostics.mjs';

function config() {
  return {
    schema_version: '3.0',
    routing_data: {
      country_provider: { type: 'ripestat', refresh_interval: '24h', max_stale: '7d' },
      domain_resolver: { refresh_interval: '5m', min_ttl: 60, max_ttl: 3600, max_stale: '24h' }
    },
    sources: [{ tag: 'vpn-in', type: 'tunnel_interface', namespace: 'host', interface: 'wg0', clients: { mode: 'address_list', addresses: ['10.8.1.2/32'] } }],
    capture: { type: 'redirect', listen_port: 15001 },
    egresses: [{ tag: 'strict-egress', type: 'socks5', server: 'egress.example', port: 1080, healthcheck_url: 'https://example.com/' }, { tag: 'direct', type: 'direct' }],
    policies: [{ tag: 'regional', sources: ['vpn-in'], destination_sets: ['regional'], egress: 'strict-egress', failure_mode: 'block' }, { tag: 'default-direct', sources: ['vpn-in'], destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }],
    destination_sets: { regional: { country_codes: ['RU'], exact_domains: ['obr.site'], domain_suffixes: ['.ru'], ip_cidrs: ['203.0.113.0/24'] } },
    traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
    resources: { nftables_table: 'vpn_router', service_name: 'vpn-router' }
  };
}

function response(prefixes) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: { resources: { ipv4: prefixes }, query_time: '2026-08-22T00:00:00Z' } }) };
}

test('builds country and exact-domain state without relying on client DNS', async () => {
  const state = await buildRoutingDataState(config(), {
    now: new Date('2026-08-22T12:00:00Z'),
    fetchImpl: async () => response(['5.8.0.0/13', '5.8.0.0/13', '203.0.113.42/24']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 30 }, { address: '188.40.167.81', ttl: 120 }]
  });
  assert.equal(state.status, 'READY');
  assert.deepEqual(state.countries.RU.cidrs, ['5.8.0.0/13', '203.0.113.0/24']);
  assert.deepEqual(state.domains['obr.site'].addresses, ['188.40.167.81']);
  assert.equal(state.domains['obr.site'].ttl, 60);
  assert.deepEqual(state.destination_sets.regional.exact_ips, ['188.40.167.81']);
  assert.ok(state.sha256);
  assert.match(state.config_sha256, /^[a-f0-9]{64}$/);
});

test('keeps fresh last-known-good data and rejects missing or stale fallback', async () => {
  const first = await buildRoutingDataState(config(), {
    now: new Date('2026-08-22T12:00:00Z'),
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  const retained = await buildRoutingDataState(config(), {
    now: new Date('2026-08-22T13:00:00Z'),
    previous: first,
    fetchImpl: async () => { throw new Error('offline'); },
    resolve4: async () => { throw new Error('offline'); }
  });
  assert.equal(retained.status, 'DEGRADED');
  assert.deepEqual(retained.destination_sets, first.destination_sets);

  await assert.rejects(buildRoutingDataState(config(), {
    now: new Date('2026-09-01T13:00:00Z'),
    previous: first,
    fetchImpl: async () => { throw new Error('offline'); },
    resolve4: async () => { throw new Error('offline'); }
  }), /no fresh last-known-good/);
});

test('rejects empty initial data and retains a fresh set after suspicious shrinkage', async () => {
  await assert.rejects(buildRoutingDataState(config(), {
    fetchImpl: async () => response([]),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  }), /empty IPv4/);
  assert.equal(canonicalIpv4Cidr('203.0.113.42/24'), '203.0.113.0/24');
  assert.deepEqual(normalizeIpv4Cidrs(['10.0.1.0/24', '10.0.0.0/8', '10.0.0.0/8']), ['10.0.0.0/8']);

  const previousBase = await buildRoutingDataState(config(), {
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  const previous = { ...previousBase, countries: { RU: { cidrs: Array.from({ length: 100 }, (_, index) => `10.${index}.0.0/16`), retrieved_at: new Date().toISOString() } } };
  const retained = await buildRoutingDataState(config(), {
    previous,
    force: true,
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  assert.equal(retained.status, 'DEGRADED');
  assert.deepEqual(retained.countries.RU.cidrs, previous.countries.RU.cidrs);
  assert.match(retained.countries.RU.retained_error, /shrank by more than 50 percent/);
});

test('writes an atomic private state file with integrity verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-data-'));
  const path = join(directory, 'state.json');
  const state = await buildRoutingDataState(config(), {
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  await writeRoutingDataState(path, state);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readRoutingDataState(path), state);
});

test('reports expired required data as FAILED without discarding it', async () => {
  const state = await buildRoutingDataState(config(), {
    now: new Date('2026-08-01T00:00:00Z'),
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  const assessment = assessRoutingDataState(config(), state, new Date('2026-08-22T00:00:00Z'));
  assert.equal(assessment.status, 'FAILED');
  assert.ok(assessment.warnings.includes('country:RU:stale'));
  assert.ok(assessment.warnings.includes('domain:obr.site:stale'));
  assert.deepEqual(state.destination_sets.regional.country_cidrs, ['5.8.0.0/13']);
});

test('data status CLI reads the verified state instead of an undefined runtime value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vpn-router-data-cli-'));
  const configPath = join(directory, 'router.yaml');
  const statePath = join(directory, 'state.json');
  await writeFile(configPath, stringify(config()), { mode: 0o600 });
  const state = await buildRoutingDataState(config(), {
    fetchImpl: async () => response(['5.8.0.0/13']),
    resolve4: async () => [{ address: '188.40.167.81', ttl: 300 }]
  });
  await writeRoutingDataState(statePath, state);
  const result = spawnSync(process.execPath, [new URL('../bin/vpn-router-data.mjs', import.meta.url).pathname, 'status', '--config', configPath, '--state', statePath, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'READY');
});

test('runtime diagnosis reports real selector counters and managed egress state', () => {
  const nft = {
    nftables: [
      { rule: { expr: [{ match: { left: { payload: { protocol: 'ip', field: 'daddr' } }, op: '==', right: '@set_regional_country' } }, { counter: { packets: 4, bytes: 240 } }] } },
      { rule: { expr: [{ match: { left: { payload: { protocol: 'ip', field: 'daddr' } }, op: '==', right: '@set_regional_exact' } }, { counter: { packets: 2, bytes: 120 } }] } }
    ]
  };
  assert.deepEqual(summarizeNftCounters(nft), {
    packets: 6,
    bytes: 360,
    selector_sets: {
      set_regional_country: { packets: 4, bytes: 240 },
      set_regional_exact: { packets: 2, bytes: 120 }
    }
  });

  const execute = (file, args) => {
    if (file === 'nft') return JSON.stringify(nft);
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  const runtime = collectRuntimeDiagnostics(config(), { execute });
  assert.equal(runtime.routing_state, 'APPLIED');
  assert.equal(runtime.egress.status, 'EXTERNAL_MANAGED');
  assert.equal(runtime.packet_counters[0].selector_sets.set_regional_country.packets, 4);
});
