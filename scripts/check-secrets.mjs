#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && existsSync(file));
const patterns = [
  ['Amnezia vpn text key', /vpn:\/\/[A-Za-z0-9_-]{100,}/],
  ['Tailscale auth key', /tskey-(?:auth|client|api)-[A-Za-z0-9_-]{20,}/],
  ['PEM private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['native VPN private key', /^\s*PrivateKey\s*=\s*(?!TEST_|EXAMPLE_|<)[A-Za-z0-9+/=_-]{32,}\s*$/m],
  ['native VPN preshared key', /^\s*PresharedKey\s*=\s*(?!TEST_|EXAMPLE_|<)[A-Za-z0-9+/=_-]{32,}\s*$/m]
];
const findings = [];

for (const file of files) {
  if (/\.vpn$/i.test(file)) {
    findings.push(`${file}: VPN profile files are forbidden`);
    continue;
  }
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`secret_check=FAIL\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('secret_check=PASS\n');
}
