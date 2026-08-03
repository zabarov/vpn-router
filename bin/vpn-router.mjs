#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parseDocument } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';
import { generateNftablesConfig } from '../src/nftables-generator.mjs';
import { generateDnsmasqConfig } from '../src/dnsmasq-generator.mjs';
import { sourceClientScope } from '../src/config-normalizer.mjs';

function usage() {
  return 'Usage: vpn-router <validate|render-sing-box|render-nftables|render-dnsmasq|render-runtime-env> --config <path>';
}

function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('runtime values cannot contain NUL bytes');
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function main(argv) {
  const [command, option, configPath, ...extraArgs] = argv;
  if (!['validate', 'render-sing-box', 'render-nftables', 'render-dnsmasq', 'render-runtime-env'].includes(command) || option !== '--config' || !configPath || extraArgs.length > 0) {
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
  if (command === 'render-dnsmasq') {
    process.stdout.write(generateDnsmasqConfig(document.toJS()));
    return;
  }
  if (command === 'render-runtime-env') {
    const config = document.toJS();
    const source = config.sources[0];
    const strictPolicy = config.policies.find((policy) => policy.failure_mode === 'block');
    const strictEgress = config.egresses.find((egress) => egress.tag === strictPolicy.egress);
    const clientScope = sourceClientScope(source);
    const fields = {
      SOURCE_TYPE: source.type,
      SOURCE_CONTAINER: source.container_name ?? 'none',
      SOURCE_INTERFACE: source.interface,
      CLIENT_SCOPE_MODE: clientScope.mode,
      CLIENT_SCOPE_CIDRS: clientScope.cidrs.join(','),
      MANAGED_DNS_REQUIRED: strictPolicy.destination_sets.some((name) =>
        (config.destination_sets[name]?.domain_suffixes ?? []).length > 0
      ),
      STRICT_EGRESS_TAG: strictEgress.tag,
      STRICT_EGRESS_TYPE: strictEgress.type,
      STRICT_EGRESS_SERVER: strictEgress.proxy_server ?? strictEgress.server ?? 'none',
      STRICT_EGRESS_PORT: strictEgress.proxy_port ?? strictEgress.port ?? 'none',
      STRICT_EGRESS_INTERFACE: strictEgress.interface ?? 'none',
      STRICT_EGRESS_HEALTHCHECK_URL: strictEgress.healthcheck_url,
      TAILSCALE_AUTH_KEY_ENV: strictEgress.auth_key_env ?? 'none',
      TAILSCALE_EXIT_NODE: strictEgress.exit_node ?? 'none',
      TAILSCALE_PROXY_SERVER: strictEgress.proxy_server ?? 'none',
      TAILSCALE_PROXY_PORT: strictEgress.proxy_port ?? 'none',
      TAILSCALE_HEALTHCHECK_URL: strictEgress.type === 'tailscale_socks' ? strictEgress.healthcheck_url : 'none',
      NFTABLES_TABLE: config.resources.nftables_table,
      SERVICE_NAME: config.resources.service_name
    };
    for (const [key, value] of Object.entries(fields)) process.stdout.write(`${key}=${shellQuote(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(generateSingBoxConfig(document.toJS()), null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
