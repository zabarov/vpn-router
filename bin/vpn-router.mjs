#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseDocument, stringify } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';
import { generateNftablesConfig } from '../src/nftables-generator.mjs';
import { generateDnsmasqConfig } from '../src/dnsmasq-generator.mjs';
import { migrateConfig, normalizeConfig, sourceClientScope } from '../src/config-normalizer.mjs';
import { buildRuntimePlan } from '../src/runtime-plan.mjs';

function usage() {
  return 'Usage: vpn-router <validate|render-dnsmasq|render-runtime-env|render-runtime-plan> --config <path>\n       vpn-router <render-nftables|render-sing-box> --config <path> [--source <tag>]\n       vpn-router migrate-config --input <path> --output <path>';
}

function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('runtime values cannot contain NUL bytes');
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function main(argv) {
  if (argv[0] === 'migrate-config') {
    const [, inputOption, inputPath, outputOption, outputPath, ...extraArgs] = argv;
    if (inputOption !== '--input' || !inputPath || outputOption !== '--output' || !outputPath || extraArgs.length > 0 || inputPath === outputPath) throw new Error(usage());
    const source = await readFile(inputPath, 'utf8');
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error(`YAML parse error: ${document.errors[0].message}`);
    const config = document.toJS();
    const result = validateConfig(config);
    if (!result.valid) throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
    const migrated = migrateConfig(config);
    await writeFile(outputPath, stringify(migrated, { lineWidth: 0 }), { mode: 0o600, flag: 'wx' });
    process.stdout.write(`Migrated configuration written to: ${outputPath}\n`);
    return;
  }
  const [command, option, configPath, sourceOption, sourceTag, ...extraArgs] = argv;
  const hasSourceSelector = sourceOption === '--source' && Boolean(sourceTag) && extraArgs.length === 0;
  const hasNoExtraArgs = sourceOption === undefined && sourceTag === undefined && extraArgs.length === 0;
  if (!['validate', 'render-sing-box', 'render-nftables', 'render-dnsmasq', 'render-runtime-env', 'render-runtime-plan'].includes(command) || option !== '--config' || !configPath || (!hasNoExtraArgs && !(['render-nftables', 'render-sing-box'].includes(command) && hasSourceSelector))) {
    throw new Error(usage());
  }

  const source = await readFile(configPath, 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`YAML parse error: ${document.errors[0].message}`);
  }

  const rawConfig = document.toJS();
  const result = validateConfig(rawConfig);
  if (!result.valid) {
    throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
  }
  if (command === 'validate') {
    process.stdout.write(`Configuration is valid: ${configPath}\n`);
    return;
  }
  if (command === 'render-nftables') {
    process.stdout.write(generateNftablesConfig(normalizeConfig(rawConfig), { sourceTag: hasSourceSelector ? sourceTag : undefined }));
    return;
  }
  if (command === 'render-dnsmasq') {
    process.stdout.write(generateDnsmasqConfig(normalizeConfig(rawConfig)));
    return;
  }
  if (command === 'render-runtime-plan') {
    process.stdout.write(`${JSON.stringify(buildRuntimePlan(rawConfig), null, 2)}\n`);
    return;
  }
  if (command === 'render-runtime-env') {
    const config = normalizeConfig(rawConfig);
    const source = config.sources[0];
    const runtimeSource = rawConfig.schema_version === '1.0' ? rawConfig.sources[0] : source;
    const strictPolicy = config.policies.find((policy) => policy.failure_mode === 'block');
    const strictEgress = config.egresses.find((egress) => egress.tag === strictPolicy.egress);
    const clientScope = sourceClientScope(runtimeSource);
    const fields = {
      CONFIG_SCHEMA_VERSION: rawConfig.schema_version,
      SOURCE_TYPE: runtimeSource.type,
      SOURCE_COUNT: config.sources.length,
      SOURCE_TAGS: config.sources.map((candidate) => candidate.tag).join(','),
      SOURCES_JSON: JSON.stringify(config.sources),
      SOURCE_CONTAINER: runtimeSource.container_name ?? 'none',
      SOURCE_INTERFACE: runtimeSource.interface ?? 'none',
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
  process.stdout.write(`${JSON.stringify(generateSingBoxConfig(normalizeConfig(rawConfig), { sourceTag: hasSourceSelector ? sourceTag : undefined }), null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
