import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const install = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
const command = await readFile(new URL('../scripts/vpn-router-command.sh', import.meta.url), 'utf8');
const service = await readFile(new URL('../scripts/vpn-router-service.sh', import.meta.url), 'utf8');
const unit = await readFile(new URL('../deploy/systemd/vpn-router.service', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('../scripts/vpn-router-lifecycle.sh', import.meta.url), 'utf8');

test('installer uses immutable release directories and a verified private Node runtime', () => {
  assert.match(install, /NODE_VERSION='24[.]18[.]0'/);
  assert.match(install, /NODE_SHA256_X64='[a-f0-9]{64}'/);
  assert.match(install, /NODE_SHA256_ARM64='[a-f0-9]{64}'/);
  assert.match(install, /sha256sum -c/);
  assert.match(install, /release_dir="\$releases_dir\/\$release_id"/);
  assert.match(install, /mv -Tf "\$current_link[.]new" "\$current_link"/);
  assert.match(install, /npm" ci --omit=dev --ignore-scripts/);
});

test('dependency installation preserves an existing distribution Docker stack', () => {
  assert.match(install, /apt-cache show docker-compose-v2/);
  assert.match(install, /apt-get install -y docker-compose-v2/);
  assert.match(install, /existing Docker package has no compatible Compose v2 package/);
  const repoSetup = install.indexOf('curl -fsSL "https://download.docker.com');
  const distroCompose = install.indexOf('apt-get install -y docker-compose-v2');
  assert.ok(distroCompose >= 0 && repoSetup > distroCompose);
});

test('upgrade keeps a previous release and supports an atomic version rollback', () => {
  assert.match(install, /ln -sfn "\$old_current" "\$previous_link"/);
  assert.match(install, /rollback-version=PASS/);
  assert.match(install, /validate --config "\$config_path\/router[.]yaml"/);
  assert.doesNotMatch(install, /git reset|git checkout|git pull/);
});

test('safe uninstall disables an active runtime and preserves state unless purge is explicit', () => {
  assert.match(install, /active_manifest=true/);
  assert.match(install, /systemctl is-active --quiet vpn-router[.]service/);
  assert.match(install, /the systemd service could not stop safely; installation was preserved/);
  assert.match(install, /routing could not be disabled safely; installation was preserved/);
  assert.match(install, /if \[\[ "\$purge" == true \]\]/);
  assert.match(install, /preserved=\$config_dir,\/var\/lib\/<service_name>/);
});

test('installed command exposes configuration, lifecycle, service, and routing switch operations', () => {
  for (const name of ['discover', 'configure', 'validate', 'doctor', 'preflight', 'enable', 'disable', 'status', 'verify', 'rollback', 'reconcile', 'service-enable', 'service-disable', 'service-status']) {
    assert.match(command, new RegExp(name.replace('-', '[-]')));
  }
  assert.match(command, /default_config=.*\/etc\/vpn-router\/router[.]yaml/);
});

test('systemd boot reconciliation is explicit, bounded, and fail-closed', () => {
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /RemainAfterExit=yes/);
  assert.match(unit, /After=network-online[.]target docker[.]service/);
  assert.match(unit, /ExecStart=.*vpn-router-service[.]sh start/);
  assert.match(unit, /ExecStop=.*vpn-router-service[.]sh stop/);
  assert.match(service, /deadline=\$\(\(SECONDS \+ wait_seconds\)\)/);
  assert.match(service, /reconcile --config/);
  assert.match(service, /verify --config .* --cancel-deadman/);
});

test('source recreation recovery archives evidence and refuses ambiguous new resources', () => {
  const start = lifecycle.indexOf('recover_recreated_source()');
  const end = lifecycle.indexOf('apply_command()', start);
  const recovery = lifecycle.slice(start, end);
  assert.match(recovery, /current_source_id.*MANIFEST_SOURCE_ID/);
  assert.match(recovery, /owned_table_exists \|\| source_on_proxy_network/);
  assert.match(recovery, /previous-manifest[.]env/);
  assert.match(recovery, /compose down --remove-orphans/);
  assert.match(recovery, /rm -f "\$MANIFEST" "\$STORED_CONFIG"/);
});
