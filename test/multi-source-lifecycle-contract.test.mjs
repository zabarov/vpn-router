import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const lifecycle = await readFile(new URL('../scripts/vpn-router-source-lifecycle.sh', import.meta.url), 'utf8');
const dispatcher = await readFile(new URL('../scripts/vpn-router-lifecycle.sh', import.meta.url), 'utf8');

test('schema 2 dispatches to the transactional multi-source lifecycle', () => {
  assert.match(dispatcher, /CONFIG_SCHEMA_VERSION" == 2[.]0/);
  assert.match(dispatcher, /vpn-router-source-lifecycle[.]sh/);
  assert.match(lifecycle, /render-runtime-plan/);
  assert.match(lifecycle, /groups_tsv/);
});

test('multi-source enable arms rollback before applying namespace state', () => {
  const apply = lifecycle.slice(lifecycle.indexOf('apply_runtime()'), lifecycle.indexOf('status_runtime()'));
  assert.ok(apply.indexOf('capture_baseline') < apply.indexOf('write_manifest applying'));
  assert.ok(apply.indexOf('write_manifest applying') < apply.indexOf('arm_deadman'));
  assert.ok(apply.indexOf('arm_deadman') < apply.indexOf('start_egress'));
  assert.match(apply, /rollback_runtime true/);
});

test('source VPN containers are borrowed and never stopped or removed', () => {
  assert.doesNotMatch(lifecycle, /docker (?:rm|stop|restart)[^\n]*"\$container"/);
  assert.match(lifecycle, /docker network disconnect -f "\$PROXY_NETWORK" "\$container"/);
  assert.match(lifecycle, /source container changed/);
});

test('every source group owns capture, DNS, nftables, and baseline evidence', () => {
  assert.match(lifecycle, /capture_name/);
  assert.match(lifecycle, /dns_name/);
  assert.match(lifecycle, /nft list table inet "\$NFTABLES_TABLE"/);
  assert.match(lifecycle, /verify_baseline/);
  assert.match(lifecycle, /source-ids[.]tsv/);
  assert.match(lifecycle, /owned_absent/);
});

test('managed Tailscale state survives disable and bootstrap credentials are scrubbed', () => {
  assert.match(lifecycle, /EGRESS_STATE/);
  assert.match(lifecycle, /TS_AUTHKEY=/);
  assert.match(lifecycle, /auth_value=''/);
  assert.doesNotMatch(lifecycle, /rm -rf "\$EGRESS_STATE"/);
});

test('container namespaces pin the managed SOCKS address instead of depending on source DNS', () => {
  assert.match(lifecycle, /pin_tailscale_proxy_ip/);
  assert.match(lifecycle, /outbound\.server=server/);
  assert.match(lifecycle, /delete outbound\.domain_resolver/);
  assert.match(lifecycle, /start_egress; pin_tailscale_proxy_ip; attach_sources/);
});

test('strict egress readiness tolerates startup DNS delay and requires stable recovery', () => {
  assert.match(lifecycle, /healthcheck_group_once\(\)/);
  assert.match(lifecycle, /for _attempt in \{1\.\.30\}/);
  assert.match(lifecycle, /consecutive >= 3/);
  assert.match(lifecycle, /consecutive=0/);
});

test('lifecycle operations are serialized and status avoids expensive network probes', () => {
  assert.match(lifecycle, /exec 9>"\/run\/lock\/vpn-router-\$lock_key[.]lock"/);
  assert.match(lifecycle, /status\|verify\) flock -w 600 9/);
  assert.match(lifecycle, /\*\) flock -n 9/);

  const statusStart = lifecycle.indexOf('status_runtime()');
  const status = lifecycle.slice(statusStart, lifecycle.indexOf('case "$command_name"', statusStart));
  assert.match(status, /status_health=structurally_healthy/);
  assert.doesNotMatch(status, /healthcheck_group/);
});

test('preflight reuses the pinned DNS helper image when it already exists', () => {
  assert.match(lifecycle, /docker image inspect "\$DNS_IMAGE"[^\n]+\|\| docker build/);
});
