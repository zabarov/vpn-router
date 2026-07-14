#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parseDocument } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';
import { generateNftablesConfig } from '../src/nftables-generator.mjs';

function usage() {
  return 'Usage: vpn-router <validate|render-sing-box|render-nftables> --config <path> [--include-auth-key-from-env]';
}

async function main(argv) {
  const [command, option, configPath, authOption] = argv;
  if (!['validate', 'render-sing-box', 'render-nftables'].includes(command) || option !== '--config' || !configPath || (authOption && authOption !== '--include-auth-key-from-env') || (authOption && command !== 'render-sing-box')) {
    throw new Error(usage());
  }

  const source = await readFile(configPath, 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`YAML parse error: ${document.errors[0].message}`);
  }

  const result = validateConfig(document.toJS());
  if (!result.valid) {
    throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
  }
  if (command === 'validate') {
    process.stdout.write(`Configuration is valid: ${configPath}\n`);
    return;
  }
  if (command === 'render-nftables') {
    process.stdout.write(generateNftablesConfig(document.toJS()));
    return;
  }
  const authKeys = {};
  if (authOption) {
    for (const egress of document.toJS().egresses.filter((egress) => egress.type === 'tailscale')) {
      const authKey = process.env[egress.auth_key_env];
      if (!authKey) throw new Error(`Missing required environment variable: ${egress.auth_key_env}`);
      authKeys[egress.auth_key_env] = authKey;
    }
  }
  process.stdout.write(`${JSON.stringify(generateSingBoxConfig(document.toJS(), { authKeys }), null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
