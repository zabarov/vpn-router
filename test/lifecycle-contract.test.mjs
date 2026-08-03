import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lifecyclePath = new URL('../scripts/vpn-router-lifecycle.sh', import.meta.url);

test('exposes an idempotent routing switch without disabling the source VPN', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  assert.match(source, /vpn-router-lifecycle[.]sh enable --config/);
  assert.match(source, /vpn-router-lifecycle[.]sh disable --config/);
  assert.match(source, /enable\|apply\) apply_command/);
  assert.match(source, /disable\|rollback\)/);
  assert.match(source, /write_manifest "\$final_status"/);
  assert.match(source, /disable=ALREADY_DISABLED/);
  assert.doesNotMatch(source, /docker (?:stop|rm).*\$SOURCE_CONTAINER/);
});

test('managed apply fails immediately when a guarded runtime step fails', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  assert.match(source, /wait_for_tailscale \|\| return 1/);
  assert.match(source, /wait_for_socks_egress \|\| return 1/);
  assert.match(source, /consecutive >= 3/);
  assert.match(source, /verify_internal \|\| return 1/);
  assert.doesNotMatch(source, /ip rule add|ip route add local/);
  assert.doesNotMatch(source, /if ! \(\s*set -e[\s\S]*?compose up -d vpn-router-egress/);
});

test('status reports drift instead of trusting an applied manifest alone', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const statusStart = source.indexOf('status_command()');
  const statusEnd = source.indexOf('verify_command()', statusStart);
  const status = source.slice(statusStart, statusEnd);
  assert.match(status, /reported_status=drifted/);
  assert.match(status, /verify_internal/);
  assert.match(status, /nftables_table_present/);
  assert.match(status, /source_proxy_connected/);
  assert.match(status, /client_scope_mode=\$CLIENT_SCOPE_MODE/);
  assert.match(status, /client_scope_entries=/);
  assert.match(status, /strict_egress_type=\$STRICT_EGRESS_TYPE/);
});

test('an active manifest must match both the stored and requested config', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const matcherStart = source.indexOf('manifest_matches_current_config()');
  const matcherEnd = source.indexOf('require_matching_active_manifest()', matcherStart);
  const matcher = source.slice(matcherStart, matcherEnd);
  assert.match(matcher, /MANIFEST_CONFIG_SHA256.*file_sha256 "\$STORED_CONFIG"/);
  assert.match(matcher, /MANIFEST_CONFIG_SHA256.*file_sha256 "\$config_path"/);
  assert.match(source, /manifest does not match this config/);
  assert.match(source, /config_path=\$invocation_config/);
});

test('runtime verification checks the selected exit and adapter-specific HTTPS path', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const verifyStart = source.indexOf('verify_internal()');
  const verifyEnd = source.indexOf('cancel_deadman_timer()', verifyStart);
  const verify = source.slice(verifyStart, verifyEnd);
  assert.match(verify, /ExitNodeStatus\?\.Online===true/);
  assert.match(verify, /wait_for_socks_egress/);
  assert.match(verify, /egress_auth_key_scrubbed \|\| return 1/);

  const healthStart = source.indexOf('wait_for_socks_egress()');
  const healthEnd = source.indexOf('capture_failure_evidence()', healthStart);
  const health = source.slice(healthStart, healthEnd);
  assert.match(health, /STRICT_EGRESS_TYPE" == socks5/);
  assert.match(health, /--socks5-hostname/);
  assert.match(health, /STRICT_EGRESS_TYPE" == linux_interface/);
  assert.match(health, /--interface "\$STRICT_EGRESS_INTERFACE"/);
  assert.match(health, /STRICT_EGRESS_HEALTHCHECK_URL/);
});

test('first enrollment recreates the egress without the Tailscale auth key', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const applyStart = source.indexOf('apply_runtime()');
  const applyEnd = source.indexOf('if ! apply_runtime', applyStart);
  const apply = source.slice(applyStart, applyEnd);
  assert.match(apply, /auth_key=''/);
  assert.match(apply, /unset "\$TAILSCALE_AUTH_KEY_ENV"/);
  assert.match(apply, /--force-recreate vpn-router-egress/);
  assert.match(apply, /egress_auth_key_scrubbed \|\| return 1/);
  assert.match(source, /\^tskey-auth-\[A-Za-z0-9_-\]\{20,/);
});

test('external egress adapters are health-checked but never lifecycle-owned', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const preflightStart = source.indexOf('preflight_command()');
  const preflightEnd = source.indexOf('capture_backup()', preflightStart);
  const preflight = source.slice(preflightStart, preflightEnd);
  assert.match(preflight, /STRICT_EGRESS_TYPE" == socks5/);
  assert.match(preflight, /STRICT_EGRESS_TYPE" == linux_interface/);

  const applyStart = source.indexOf('apply_runtime()');
  const applyEnd = source.indexOf('if ! apply_runtime', applyStart);
  const apply = source.slice(applyStart, applyEnd);
  assert.match(apply, /if uses_managed_tailscale; then\s+compose up -d vpn-router-egress/);
  assert.match(apply, /wait_for_socks_egress \|\| return 1/);
  assert.doesNotMatch(apply, /docker (?:stop|rm).*STRICT_EGRESS/);
});

test('managed lifecycle supports a host Linux VPN interface without container ownership', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  assert.match(source, /compose[.]linux-interface[.]yaml/);
  assert.match(source, /uses_container_source\(\)/);
  assert.match(source, /printf 'host:%s'.*boot_id/);
  assert.match(source, /source_container_running=not_applicable/);
  assert.match(source, /a host Linux source requires an external SOCKS5 or Linux-interface egress/);
  assert.doesNotMatch(source, /managed apply currently supports amneziawg2_container/);
  assert.match(source, /if uses_managed_dns; then\s+compose up -d vpn-router-dns vpn-router/);
  assert.match(source, /dns_running=not_applicable/);
});

test('the rollback deadman is armed before the first live runtime step', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const manifest = source.indexOf('write_manifest applying "$backup_dir" false');
  const deadman = source.indexOf('arm_deadman_timer "$rollback_after"', manifest);
  const runtime = source.indexOf('if ! apply_runtime', deadman);
  assert.ok(manifest >= 0 && deadman > manifest && runtime > deadman);
});

test('rollback verifies absence before reporting success', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const rollbackStart = source.indexOf('rollback_command()');
  const rollbackEnd = source.indexOf('apply_command()', rollbackStart);
  const rollback = source.slice(rollbackStart, rollbackEnd);
  assert.match(rollback, /wait_for_owned_runtime_absent \|\| rollback_ok=false/);
  assert.match(rollback, /write_manifest rollback_failed/);
  assert.match(rollback, /cancel_deadman_timer/);
  assert.match(rollback, /rollback=ALREADY_ROLLED_BACK/);
  assert.match(rollback, /if container_exists "\$CAPTURE_NAME"/);
  assert.match(rollback, /compose stop vpn-router >\/dev\/null/);
  assert.match(rollback, /if container_exists "\$DNS_NAME"/);
  assert.match(rollback, /compose stop vpn-router-dns >\/dev\/null/);
  assert.match(rollback, /wait_for_baseline_restored \|\| rollback_ok=false/);
});

test('rollback tolerates bounded asynchronous resource and route cleanup', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  assert.match(source, /wait_for_owned_runtime_absent\(\)/);
  assert.match(source, /for _attempt in \{1[.]\.20\}/);
  assert.match(source, /wait_for_baseline_restored\(\)/);
  assert.match(source, /for _attempt in \{1[.]\.10\}/);
});

test('rollback compares stable network semantics instead of expiring lease timers', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const normalizerStart = source.indexOf('normalize_network_json()');
  const normalizerEnd = source.indexOf('manifest_matches_current_config()', normalizerStart);
  const normalizer = source.slice(normalizerStart, normalizerEnd);
  assert.match(normalizer, /"expires"/);
  assert.match(normalizer, /"preferred_life_time"/);
  assert.match(normalizer, /"valid_life_time"/);
  assert.match(normalizer, /Object[.]keys\(value\)[.]sort\(\)/);

  const verifyStart = source.indexOf('verify_baseline_restored()');
  const verifyEnd = source.indexOf('write_manifest()', verifyStart);
  const verify = source.slice(verifyStart, verifyEnd);
  assert.match(verify, /normalize_network_json "\$MANIFEST_BACKUP_DIR\/\$file"/);
  assert.match(verify, /cmp -s "\$verification_dir\/baseline-\$file" "\$verification_dir\/stable-\$file"/);
});

test('the root-only baseline covers host, source, and SSH routing state', async () => {
  const source = await readFile(lifecyclePath, 'utf8');
  const backupStart = source.indexOf('capture_backup()');
  const backupEnd = source.indexOf('write_manifest()', backupStart);
  const backup = source.slice(backupStart, backupEnd);
  for (const name of ['host-addresses.json', 'host-routes.json', 'host-rules.json', 'host-nftables.json', 'host-ssh-route.json', 'source-addresses.json', 'source-routes.json', 'source-rules.json', 'source-nftables.json']) {
    assert.match(backup, new RegExp(name.replaceAll('.', '[.]')));
  }
});
