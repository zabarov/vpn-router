#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseDocument } from 'yaml';
import { assessRoutingDataState, buildRoutingDataState, defaultRoutingDataPath, readRoutingDataState, routingDataRequirements, writeRoutingDataState } from '../src/routing-data.mjs';
import { normalizeConfig } from '../src/config-normalizer.mjs';
import { validateConfig } from '../src/config-validator.mjs';
import { collectRuntimeDiagnostics } from '../src/runtime-diagnostics.mjs';

function usage() {
  return 'Usage:\n  vpn-router-data update --config <path> [--state <path>]\n  vpn-router-data status --config <path> [--state <path>] [--json]\n  vpn-router-data diagnose <domain> --config <path> [--state <path>] [--json]';
}

async function loadConfig(path) {
  const document = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`YAML parse error: ${document.errors[0].message}`);
  const config = document.toJS();
  const result = validateConfig(config);
  if (!result.valid) throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
  return normalizeConfig(config);
}

function parseOptions(args) {
  const options = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--json') options.json = true;
    else if (item === '--config' || item === '--state') {
      if (!args[index + 1]) throw new Error(usage());
      options[item.slice(2)] = args[index + 1];
      index += 1;
    } else throw new Error(usage());
  }
  if (!options.config) throw new Error(usage());
  return options;
}

function ipv4Number(address) {
  return address.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function inCidr(address, cidr) {
  if (isIP(address) !== 4) return false;
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function classify(config, state, domain, addresses) {
  const matches = [];
  for (const [name, destination] of Object.entries(config.destination_sets ?? {})) {
    const exact = (destination.exact_domains ?? []).includes(domain);
    const suffix = (destination.domain_suffixes ?? []).some((item) => domain === item.slice(1) || domain.endsWith(item));
    const exactIps = new Set(state?.destination_sets?.[name]?.exact_ips ?? []);
    const countryCidrs = state?.destination_sets?.[name]?.country_cidrs ?? [];
    const staticCidrs = destination.ip_cidrs ?? [];
    if (exact || addresses.some((address) => exactIps.has(address))) matches.push({ destination_set: name, selector: 'exact_domain' });
    if (addresses.some((address) => countryCidrs.some((cidr) => inCidr(address, cidr)))) matches.push({ destination_set: name, selector: 'country_cidr' });
    if (addresses.some((address) => staticCidrs.some((cidr) => inCidr(address, cidr)))) matches.push({ destination_set: name, selector: 'static_cidr' });
    if (suffix) matches.push({ destination_set: name, selector: 'domain_suffix_best_effort' });
  }
  return matches.filter((match, index, all) => all.findIndex((candidate) => candidate.destination_set === match.destination_set && candidate.selector === match.selector) === index);
}

async function main(argv) {
  const command = argv[0];
  if (!['update', 'status', 'diagnose'].includes(command)) throw new Error(usage());
  let domain;
  let optionArgs;
  if (command === 'diagnose') {
    domain = argv[1];
    optionArgs = argv.slice(2);
    if (!domain || isIP(domain) || domain.startsWith('.') || !domain.includes('.')) throw new Error(usage());
  } else optionArgs = argv.slice(1);
  const options = parseOptions(optionArgs);
  const config = await loadConfig(options.config);
  const statePath = options.state ?? defaultRoutingDataPath(config);
  const previous = await readRoutingDataState(statePath);
  const state = previous;

  if (command === 'update') {
    const nextState = await buildRoutingDataState(config, { previous });
    await writeRoutingDataState(statePath, nextState);
    process.stdout.write(`data_update=${nextState.status}\nstate=${statePath}\nsha256=${nextState.sha256}\n`);
    return;
  }

  if (command === 'status') {
    const requirements = routingDataRequirements(config);
    const assessment = assessRoutingDataState(config, state);
    const result = { status: assessment.status, generated_at: state?.generated_at ?? null, countries: requirements.countries.length, domains: requirements.domains.length, warnings: assessment.warnings };
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else for (const [key, value] of Object.entries(result)) process.stdout.write(`${key}=${Array.isArray(value) ? value.join(',') : value}\n`);
    if (result.status === 'FAILED') process.exitCode = 1;
    return;
  }

  const resolver = new Resolver();
  const records = await resolver.resolve4(domain, { ttl: true });
  const addresses = [...new Set(records.map((record) => record.address))].sort();
  const matches = classify(config, state, domain, addresses);
  const matchedSets = new Set(matches.map((match) => match.destination_set));
  const policy = config.policies.find((candidate) => candidate.destination_sets.includes('default') || candidate.destination_sets.some((name) => matchedSets.has(name)));
  const egress = config.egresses.find((candidate) => candidate.tag === policy?.egress);
  const assessment = assessRoutingDataState(config, state);
  const runtime = collectRuntimeDiagnostics(config);
  const result = {
    domain,
    addresses,
    state_status: assessment.status,
    data_generated_at: state?.generated_at ?? null,
    matches,
    policy: policy?.tag ?? null,
    expected_egress: egress?.tag ?? null,
    expected_egress_type: egress?.type ?? null,
    routing_state: runtime.routing_state,
    egress_status: runtime.egress.status,
    egress_detail: runtime.egress.detail,
    packet_counters: runtime.packet_counters,
    warning: 'Country data describes registered network resources. Exact-domain routing can include other names sharing the same CDN address; suffix routing with DoH is best effort.'
  };
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`domain=${domain}\naddresses=${addresses.join(',')}\nstate_status=${result.state_status}\n`);
    process.stdout.write(`matches=${matches.map((match) => `${match.destination_set}:${match.selector}`).join(',')}\nwarning=${result.warning}\n`);
    process.stdout.write(`policy=${result.policy}\nexpected_egress=${result.expected_egress}\nexpected_egress_type=${result.expected_egress_type}\n`);
    process.stdout.write(`routing_state=${result.routing_state}\negress_status=${result.egress_status}\negress_detail=${result.egress_detail}\n`);
    process.stdout.write(`packet_counters=${JSON.stringify(result.packet_counters)}\n`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
