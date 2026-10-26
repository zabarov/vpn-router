import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/vpn-router-failure-evidence.sh', import.meta.url));

function runHelper(command, ...args) {
  const result = spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; ${command}`, 'test', helper, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('failure evidence keeps only eight owned snapshots and preserves other entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vpn-router-failures-'));
  const outside = await mkdtemp(join(tmpdir(), 'vpn-router-unowned-'));
  try {
    for (let day = 1; day <= 12; day++) {
      await mkdir(join(root, `202610${String(day).padStart(2, '0')}T120000Z.Abc123`));
    }
    await mkdir(join(root, 'operator-notes'));
    await symlink(outside, join(root, '20261000T120000Z.Abc123'));

    runHelper('failure_evidence_prune "$2"', root);

    const entries = await readdir(root);
    const snapshots = entries.filter((entry) => /^202610\d{2}T120000Z\.Abc123$/.test(entry)
      && entry !== '20261000T120000Z.Abc123').sort();
    assert.deepEqual(snapshots, Array.from({ length: 8 }, (_, index) =>
      `202610${String(index + 5).padStart(2, '0')}T120000Z.Abc123`));
    assert.ok(entries.includes('operator-notes'));
    assert.ok(entries.includes('20261000T120000Z.Abc123'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('failure evidence caps each command output at 32 KiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vpn-router-evidence-cap-'));
  try {
    const output = join(root, 'capture.log');
    runHelper('failure_evidence_capture "$2" printf "%070000d" 0', output);
    const bytes = await readFile(output);
    assert.equal(bytes.length, 32768);
    assert.ok(bytes.every((byte) => byte === 48));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('both lifecycles use bounded diagnostics and omit full container inspect', async () => {
  const multi = await readFile(new URL('../scripts/vpn-router-source-lifecycle.sh', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../scripts/vpn-router-lifecycle.sh', import.meta.url), 'utf8');
  for (const source of [multi, legacy]) {
    assert.match(source, /source "\$script_dir\/vpn-router-failure-evidence[.]sh"/);
    assert.match(source, /failure_evidence_prune "\$RUNTIME_DIR\/failures"/);
    assert.match(source, /failure_evidence_capture/);
    assert.doesNotMatch(source, /docker logs "\$[A-Za-z_]+" >"\$.*[.]log"/);
  }
  assert.match(multi, /docker inspect --format '\{\{json [.]State\}\}'/);
});
