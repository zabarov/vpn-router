#!/usr/bin/env node

import process from 'node:process';
import { discoverAmneziaSources } from '../src/discovery.mjs';

function usage() {
  return `Usage: vpn-router discover [--json]\n\nRead-only discovery of running AmneziaWG/WireGuard Docker sources.\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(usage());
    return;
  }
  if (args.some((argument) => argument !== '--json')) throw new Error(usage());
  const candidates = await discoverAmneziaSources();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ candidates }, null, 2)}\n`);
    return;
  }
  if (candidates.length === 0) {
    process.stdout.write('discovery=NO_CANDIDATES\nNo running AmneziaWG/WireGuard Docker source was found.\n');
    return;
  }
  process.stdout.write(`discovery=PASS\ncandidates=${candidates.length}\n`);
  candidates.forEach((candidate, index) => {
    process.stdout.write(`\n[${index + 1}] container=${candidate.container_name}\n`);
    process.stdout.write(`    interface=${candidate.interface}\n`);
    process.stdout.write(`    client_subnet=${candidate.client_subnet}\n`);
    process.stdout.write(`    discovered_client_addresses=${candidate.client_addresses.length}\n`);
  });
  if (candidates.length === 1) {
    process.stdout.write('\nNext: sudo vpn-router configure --preset amnezia-tailscale --output /etc/vpn-router/router.yaml\n');
  } else {
    process.stdout.write('\nMore than one source was found. Pass --source-container and --source-interface to configure.\n');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
