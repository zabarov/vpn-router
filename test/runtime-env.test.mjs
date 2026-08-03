import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const binPath = new URL('../bin/vpn-router.mjs', import.meta.url);

test('quotes every runtime value before the lifecycle evaluates it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vpn-router-runtime-env-'));
  const configPath = join(directory, 'router.yaml');
  const marker = join(directory, 'must-not-exist');
  const healthcheck = `https://example.com/$(>${marker})';:`;
  const config = `
schema_version: "1.0"
sources:
  - tag: source
    type: amneziawg2_container
    container_name: amnezia-awg2
    interface: awg0
    client_subnet: 10.8.1.2/32
capture:
  type: redirect
  listen_port: 12345
egresses:
  - tag: direct
    type: direct
  - tag: strict
    type: tailscale_socks
    auth_key_env: VPN_ROUTER_TAILSCALE_AUTH_KEY
    exit_node: exit.example.ts.net
    proxy_server: vpn-router-egress
    proxy_port: 1055
    healthcheck_url: "${healthcheck}"
policies:
  - tag: strict
    source: source
    destination_sets: [selected]
    egress: strict
    failure_mode: block
  - tag: default
    source: source
    destination_sets: [default]
    egress: direct
    failure_mode: direct
destination_sets:
  selected:
    domain_suffixes: [.example]
traffic_handling:
  udp_quic: reject
  ipv6: reject
  dns_mode: managed
resources:
  nftables_table: vpn_router
  service_name: vpn-router
`;

  try {
    writeFileSync(configPath, config, { mode: 0o600 });
    const output = execFileSync(process.execPath, [binPath.pathname, 'render-runtime-env', '--config', configPath], { encoding: 'utf8' });
    assert.match(output, /^TAILSCALE_HEALTHCHECK_URL='https:\/\/example[.]com\//m);
    assert.match(output, /'"'"'/);
    assert.equal(output.split('\n').filter(Boolean).every((line) => /^[A-Z_]+='.*'$/.test(line)), true);
    execFileSync('bash', ['-eu', '-c', 'eval "$1"; test "$TAILSCALE_HEALTHCHECK_URL" = "$2"', 'vpn-router-test', output, healthcheck], { stdio: 'pipe' });
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
