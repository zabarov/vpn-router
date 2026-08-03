#!/usr/bin/env node

import { chmod, link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';

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
  force: false,
  nonInteractive: false
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
  ['--nftables-table', 'nftablesTable']
]);

function usage() {
  return `Usage: vpn-router configure [options]

Interactive mode is the default. For automation, add --non-interactive and
provide topology values explicitly.

Options:
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

function parseArgs(argv) {
  const values = { ...defaults };
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
    index += 1;
  }
  return values;
}

async function ask(rl, label, current) {
  const answer = (await rl.question(`${label} [${current}]: `)).trim();
  return answer || current;
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
      values.exitNode = await ask(rl, 'Tailscale exit node name or IP', values.exitNode);
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

function buildConfig(values) {
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
  if (!values.nonInteractive) values = await collectInteractive(values);
  const config = buildConfig(values);
  const result = validateConfig(config);
  if (!result.valid) throw new Error(`Configuration is invalid:\n- ${result.errors.join('\n- ')}`);
  const output = resolve(values.output);
  await writeExclusive(output, stringify(config, { lineWidth: 0 }), values.force);
  process.stdout.write(`configuration=CREATED\npath=${output}\nmode=0600\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
