#!/usr/bin/env node

import process from 'node:process';
import { discoverVpnSources } from '../src/discovery.mjs';

function usage() {
  return `Usage: vpn-router discover [--json]\n\nRead-only discovery of running tunnel and XRay/V2Ray Docker sources.\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(usage());
    return;
  }
  if (args.some((argument) => argument !== '--json')) throw new Error(usage());
  const candidates = await discoverVpnSources();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ candidates }, null, 2)}\n`);
    return;
  }
  if (candidates.length === 0) {
    process.stdout.write('discovery=NO_CANDIDATES\nNo supported running VPN source was found.\n');
    return;
  }
  process.stdout.write(`discovery=PASS\ncandidates=${candidates.length}\n`);
  candidates.forEach((candidate, index) => {
    process.stdout.write(`\n[${index + 1}] type=${candidate.source_type}\n`);
    process.stdout.write(`    container=${candidate.container_name}\n`);
    if (candidate.interface) process.stdout.write(`    interface=${candidate.interface}\n`);
    if (candidate.client_subnet) process.stdout.write(`    client_subnet=${candidate.client_subnet}\n`);
    if (candidate.client_addresses) process.stdout.write(`    discovered_client_addresses=${candidate.client_addresses.length}\n`);
  });
  process.stdout.write('\nNext: sudo vpn-router configure --preset amnezia-tailscale --output /etc/vpn-router/router.yaml\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
