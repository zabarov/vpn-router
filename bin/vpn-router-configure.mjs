#!/usr/bin/env node

import { chmod, link, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';
import { discoverAmneziaSources } from '../src/discovery.mjs';

const defaults = {
  output: './router.yaml',
  sourceType: 'amneziawg2_container',
  sourceContainer: 'amnezia-awg',
  sourceInterface: 'awg0',
  clientScope: 'address_list',
  clientAddresses: '10.8.1.2/32',
  clientSubnet: '10.8.1.0/24',
  egressType: 'tailscale_socks',
  exitNode: 'exit-node.example.ts.net',
  socksServer: '127.0.0.1',
  socksPort: '1080',
  egressInterface: 'wg-exit',
  healthcheckUrl: 'https://example.com/',
  domains: '.ru,.xn--p1ai,.su',
  serviceName: 'vpn-router',
  nftablesTable: 'vpn_router',
  preset: null,
  force: false,
  nonInteractive: false,
  provided: new Set()
};

const optionMap = new Map([
  ['--output', 'output'],
  ['--source-type', 'sourceType'],
  ['--source-container', 'sourceContainer'],
  ['--source-interface', 'sourceInterface'],
  ['--client-scope', 'clientScope'],
  ['--client-addresses', 'clientAddresses'],
  ['--client-subnet', 'clientSubnet'],
  ['--egress-type', 'egressType'],
  ['--exit-node', 'exitNode'],
  ['--socks-server', 'socksServer'],
  ['--socks-port', 'socksPort'],
  ['--egress-interface', 'egressInterface'],
  ['--healthcheck-url', 'healthcheckUrl'],
  ['--domains', 'domains'],
  ['--service-name', 'serviceName'],
  ['--nftables-table', 'nftablesTable'],
  ['--preset', 'preset']
]);

function usage() {
  return `Usage: vpn-router configure [options]

Interactive mode is the default. For automation, add --non-interactive and
provide topology values explicitly.

Options:
  --preset <amnezia-tailscale>
  --output <path>
  --source-type <amneziawg2_container|linux_interface>
  --source-container <name>
  --source-interface <name>
  --client-scope <address_list|subnet>
  --client-addresses <cidr,cidr>
  --client-subnet <cidr>
  --egress-type <tailscale_socks|socks5|linux_interface>
  --exit-node <tailnet-name-or-ip>
  --socks-server <host> --socks-port <port>
  --egress-interface <name>
  --healthcheck-url <https-url>
  --domains <.suffix,.suffix>
  --service-name <name>
  --nftables-table <name>
  --non-interactive
  --force
`;
}

export function parseArgs(argv) {
  const values = { ...defaults, provided: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      values.force = true;
      continue;
    }
    if (argument === '--non-interactive') {
      values.nonInteractive = true;
      continue;
    }
    if (argument === '-h' || argument === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    const field = optionMap.get(argument);
    if (!field || index + 1 >= argv.length) throw new Error(usage());
    values[field] = argv[index + 1];
    values.provided.add(field);
    index += 1;
  }
  return values;
}

export async function applyPreset(values, discover = discoverAmneziaSources) {
  if (!values.preset) return values;
  requireChoice(values.preset, ['amnezia-tailscale'], 'preset');
  values.sourceType = 'amneziawg2_container';
  values.egressType = 'tailscale_socks';

  const sourceIsExplicit = values.provided.has('sourceContainer') && values.provided.has('sourceInterface');
  if (!sourceIsExplicit) {
    const candidates = await discover();
    const matching = candidates.filter((candidate) =>
      (!values.provided.has('sourceContainer') || candidate.container_name === values.sourceContainer)
      && (!values.provided.has('sourceInterface') || candidate.interface === values.sourceInterface));
    if (matching.length !== 1) {
      throw new Error(matching.length === 0
        ? 'The amnezia-tailscale preset could not find a unique VPN source. Run "vpn-router discover" and pass --source-container and --source-interface.'
        : 'The amnezia-tailscale preset found multiple VPN sources. Run "vpn-router discover" and select one with --source-container and --source-interface.');
    }
    const candidate = matching[0];
    values.sourceContainer = candidate.container_name;
    values.sourceInterface = candidate.interface;
    if (!values.provided.has('clientSubnet')) values.clientSubnet = candidate.client_subnet;
    if (!values.provided.has('clientAddresses')) {
      if (candidate.client_addresses.length === 0) {
        throw new Error('No configured VPN client /32 was discovered. Add one test client or pass --client-addresses explicitly.');
      }
      values.clientAddresses = candidate.client_addresses[0];
      values.provided.add('clientAddresses');
    }
  }

  if (values.clientScope === 'address_list' && !values.provided.has('clientAddresses')) {
    throw new Error('The preset requires a real canary /32. Pass --client-addresses or omit source options so discovery can select a configured client.');
  }
  if (values.nonInteractive && !values.provided.has('exitNode')) {
    throw new Error('The non-interactive amnezia-tailscale preset requires --exit-node.');
  }
  if (!values.provided.has('exitNode')) values.exitNode = '';
  return values;
}

async function ask(rl, label, current) {
  const suffix = current ? ` [${current}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || current;
}

async function askRequired(rl, label, current) {
  let value = current;
  while (!value) value = await ask(rl, label, value);
  return value;
}

async function collectInteractive(values) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    values.output = await ask(rl, 'Configuration output path', values.output);
    values.sourceType = await ask(rl, 'VPN source type', values.sourceType);
    if (values.sourceType === 'amneziawg2_container') {
      values.sourceContainer = await ask(rl, 'VPN source container name', values.sourceContainer);
    }
    values.sourceInterface = await ask(rl, 'VPN source interface', values.sourceInterface);
    values.clientScope = await ask(rl, 'Client scope (address_list or subnet)', values.clientScope);
    if (values.clientScope === 'subnet') {
      values.clientSubnet = await ask(rl, 'Explicit VPN client subnet', values.clientSubnet);
    } else {
      values.clientAddresses = await ask(rl, 'Canary client addresses, comma separated', values.clientAddresses);
    }
    values.egressType = await ask(rl, 'Strict egress type', values.egressType);
    if (values.egressType === 'tailscale_socks') {
      values.exitNode = await askRequired(rl, 'Tailscale exit node name or IP', values.exitNode);
    } else if (values.egressType === 'socks5') {
      values.socksServer = await ask(rl, 'SOCKS5 server visible from the VPN namespace', values.socksServer);
      values.socksPort = await ask(rl, 'SOCKS5 port', values.socksPort);
    } else {
      values.egressInterface = await ask(rl, 'Existing strict egress interface', values.egressInterface);
    }
    values.healthcheckUrl = await ask(rl, 'Credential-free HTTPS healthcheck URL', values.healthcheckUrl);
    values.domains = await ask(rl, 'Strict domain suffixes, comma separated', values.domains);
    values.serviceName = await ask(rl, 'Service name', values.serviceName);
    values.nftablesTable = await ask(rl, 'Owned nftables table', values.nftablesTable);
  } finally {
    rl.close();
  }
  return values;
}

function commaList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function requireChoice(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
}

export function buildConfig(values) {
  requireChoice(values.sourceType, ['amneziawg2_container', 'linux_interface'], 'source type');
  requireChoice(values.clientScope, ['address_list', 'subnet'], 'client scope');
  requireChoice(values.egressType, ['tailscale_socks', 'socks5', 'linux_interface'], 'egress type');
  const source = {
    tag: 'vpn-source',
    type: values.sourceType,
    interface: values.sourceInterface,
    client_scope: values.clientScope === 'subnet'
      ? { mode: 'subnet', subnet: values.clientSubnet }
      : { mode: 'address_list', addresses: commaList(values.clientAddresses) }
  };
  if (values.sourceType === 'amneziawg2_container') source.container_name = values.sourceContainer;

  let strictEgress;
  if (values.egressType === 'tailscale_socks') {
    strictEgress = {
      tag: 'strict-egress',
      type: 'tailscale_socks',
      auth_key_env: 'VPN_ROUTER_TAILSCALE_AUTH_KEY',
      exit_node: values.exitNode,
      proxy_server: `${values.serviceName}-egress`,
      proxy_port: 1055,
      healthcheck_url: values.healthcheckUrl
    };
  } else if (values.egressType === 'socks5') {
    strictEgress = {
      tag: 'strict-egress',
      type: 'socks5',
      server: values.socksServer,
      port: Number(values.socksPort),
      healthcheck_url: values.healthcheckUrl
    };
  } else {
    strictEgress = {
      tag: 'strict-egress',
      type: 'linux_interface',
      interface: values.egressInterface,
      healthcheck_url: values.healthcheckUrl
    };
  }

  return {
    schema_version: '1.0',
    sources: [source],
    capture: { type: 'redirect', listen_port: 15001 },
    egresses: [strictEgress, { tag: 'direct', type: 'direct' }],
    policies: [
      { tag: 'strict-domains', source: 'vpn-source', destination_sets: ['strict-domains'], egress: 'strict-egress', failure_mode: 'block' },
      { tag: 'default-direct', source: 'vpn-source', destination_sets: ['default'], egress: 'direct', failure_mode: 'direct' }
    ],
    destination_sets: {
      'strict-domains': { domain_suffixes: commaList(values.domains) }
    },
    traffic_handling: { udp_quic: 'reject', ipv6: 'reject', dns_mode: 'managed' },
    resources: { nftables_table: values.nftablesTable, service_name: values.serviceName }
  };
}

async function writeExclusive(path, content, force) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.close();
    if (force) {
      await rename(temporary, path);
    } else {
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing configuration: ${path}`);
        throw error;
      }
      await rm(temporary);
    }
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  let values = parseArgs(process.argv.slice(2));
  values = await applyPreset(values);
  if (!values.nonInteractive) values = await collectInteractive(values);
  const config = buildConfig(values);
  const result = validateConfig(config);
  if (!result.valid) throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
  const output = resolve(values.output);
  await writeExclusive(output, stringify(config, { lineWidth: 0 }), values.force);
  process.stdout.write(`configuration=CREATED\npath=${output}\nmode=0600\n`);
}

if (process.argv[1] && basename(process.argv[1]) === 'vpn-router-configure.mjs') {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
