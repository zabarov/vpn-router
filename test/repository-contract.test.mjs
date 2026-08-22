import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

async function text(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('release version and ignored private workspace stay consistent', async () => {
  const [packageText, versionText, changelog, gitignore] = await Promise.all([
    text('../package.json'),
    text('../VERSION'),
    text('../CHANGELOG.md'),
    text('../.gitignore')
  ]);
  const version = versionText.trim();
  assert.equal(JSON.parse(packageText).version, version);
  assert.match(changelog, new RegExp(`^## ${version.replaceAll('.', '[.]')} - Unreleased$`, 'm'));
  assert.match(gitignore, /^source\/$/m);
  assert.match(gitignore, /^\*\.vpn$/m);
});

test('release packaging uses a clean tracked-file allowlist and rejects private environment files', async () => {
  const script = await text('../scripts/build-release.sh');
  assert.match(script, /git archive --format=tar/);
  assert.match(script, /git diff --quiet/);
  assert.match(script, /git ls-files --others --exclude-standard/);
  assert.match(script, /source\/\*/);
  assert.match(script, /[.]env[.][*]/);
  assert.doesNotMatch(script, /tar .*\.[/]/);
});

test('external runtime images are immutable', async () => {
  const [deploymentText, linuxDeploymentText, namespaceLabText, redirectLabText, lifecycle, isolatedRunner, dnsDockerfile] = await Promise.all([
    text('../deploy/compose.amneziawg2.yaml'),
    text('../deploy/compose.linux-interface.yaml'),
    text('../lab/compose.yaml'),
    text('../lab/redirect/compose.yaml'),
    text('../scripts/vpn-router-lifecycle.sh'),
    text('../scripts/run-isolated-amneziawg2-client.sh'),
    text('../deploy/dnsmasq/Dockerfile')
  ]);
  for (const composeText of [deploymentText, linuxDeploymentText, namespaceLabText, redirectLabText]) {
    const compose = parse(composeText);
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.build) continue;
      assert.match(service.image, /@sha256:[a-f0-9]{64}$/, `${name} uses a mutable image reference`);
    }
  }
  assert.match(lifecycle, /@sha256:[a-f0-9]{64}/);
  assert.match(isolatedRunner, /amneziavpn\/amneziawg-go:3[.]0[.]3@sha256:[a-f0-9]{64}/);
  assert.match(dnsDockerfile, /^FROM .*@sha256:[a-f0-9]{64}$/m);
});

test('CI actions use commit SHAs and run both verification layers', async () => {
  const workflow = await text('../.github/workflows/ci.yml');
  const actionLines = workflow.split('\n').filter((line) => line.trim().startsWith('uses:'));
  assert.ok(actionLines.length > 0);
  for (const line of actionLines) assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/);
  assert.match(workflow, /npm run check$/m);
  assert.match(workflow, /npm run check:containers$/m);
});

test('the redirect lab waits for real dependencies and preserves failure diagnostics', async () => {
  const [composeText, verify] = await Promise.all([
    text('../lab/redirect/compose.yaml'),
    text('../lab/redirect/verify.sh')
  ]);
  const compose = parse(composeText);
  assert.equal(compose.services.sidecar.depends_on['socks-egress'].condition, 'service_healthy');
  assert.equal(compose.services.dns.depends_on['upstream-dns'].condition, 'service_healthy');
  for (const name of ['sidecar', 'dns', 'upstream-dns', 'socks-egress']) {
    assert.ok(compose.services[name].healthcheck, `${name} must publish a readiness check`);
  }
  assert.match(verify, /docker compose -f "\$compose_file" logs --no-color/);
  assert.match(verify, /chmod 700 "\$artifact_dir"/);
  assert.match(verify, /chmod 644 "\$artifact_dir"\/\*/);
});
