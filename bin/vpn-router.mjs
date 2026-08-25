#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseDocument, stringify } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { generateSingBoxConfig } from '../src/sing-box-generator.mjs';
import { generateNftablesConfig, generateNftablesDataUpdate } from '../src/nftables-generator.mjs';
import { generateDnsmasqConfig } from '../src/dnsmasq-generator.mjs';
import { migrateConfig, normalizeConfig, sourceClientScope } from '../src/config-normalizer.mjs';
import { buildRuntimePlan } from '../src/runtime-plan.mjs';
import { assessRoutingDataState, defaultRoutingDataPath, readRoutingDataState, routingDataRequirements } from '../src/routing-data.mjs';

function usage() {
  return 'Usage: vpn-router <validate|render-dnsmasq|render-runtime-env|render-runtime-plan> --config <path>\n       vpn-router render-sing-box --config <path> [--source <tag>]\n       vpn-router render-nftables --config <path> [--source <tag>] [--routing-data <path>]\n       vpn-router <render-data-update|render-data-restore> --config <path> --routing-data <path>\n       vpn-router migrate-config --input <path> --output <path>';
}

function parseRenderOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--config', '--source', '--routing-data'].includes(flag) || options[flag]) throw new Error(usage());
    options[flag] = value;
  }
  if (!options['--config']) throw new Error(usage());
  return { configPath: options['--config'], sourceTag: options['--source'], routingDataPath: options['--routing-data'] };
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
  const command = argv[0];
  if (!['validate', 'render-sing-box', 'render-nftables', 'render-data-update', 'render-data-restore', 'render-dnsmasq', 'render-runtime-env', 'render-runtime-plan'].includes(command)) {
    throw new Error(usage());
  }
  const options = parseRenderOptions(argv.slice(1));
  const { configPath, sourceTag } = options;
  if (!['render-nftables', 'render-data-update', 'render-data-restore'].includes(command) && options.routingDataPath) throw new Error(usage());
  if (['render-data-update', 'render-data-restore'].includes(command) && (!options.routingDataPath || sourceTag)) throw new Error(usage());
  if (!['render-nftables', 'render-sing-box'].includes(command) && sourceTag) throw new Error(usage());

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
    const config = normalizeConfig(rawConfig);
    const requirements = routingDataRequirements(config);
    let routingData;
    if (requirements.countries.length + requirements.domains.length > 0) {
      const path = options.routingDataPath ?? defaultRoutingDataPath(config);
      routingData = await readRoutingDataState(path);
      const assessment = assessRoutingDataState(config, routingData);
      if (assessment.status === 'FAILED') throw new Error(`Routing data is not usable: ${assessment.warnings.join(', ')}`);
    }
    process.stdout.write(generateNftablesConfig(config, { sourceTag, routingData }));
    return;
  }
  if (command === 'render-data-update' || command === 'render-data-restore') {
    const routingData = await readRoutingDataState(options.routingDataPath);
    const assessment = assessRoutingDataState(rawConfig, routingData);
    const structuralFailure = assessment.warnings.some((warning) => ['state_missing', 'config_mismatch'].includes(warning));
    if (assessment.status === 'FAILED' && (command !== 'render-data-restore' || structuralFailure)) {
      throw new Error(`Routing data is not usable: ${assessment.warnings.join(', ')}`);
    }
    process.stdout.write(generateNftablesDataUpdate(rawConfig, routingData));
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
  process.stdout.write(`${JSON.stringify(generateSingBoxConfig(normalizeConfig(rawConfig), { sourceTag }), null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
