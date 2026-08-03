import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultRunner(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function networkCidr(address, prefixLength) {
  const value = ipv4Number(address);
  if (value === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return null;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (value & mask) >>> 0;
  return `${[(network >>> 24), (network >>> 16) & 255, (network >>> 8) & 255, network & 255].join('.')}/${prefixLength}`;
}

function parseDockerRows(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function parsePeerAddresses(output) {
  const addresses = new Set();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/).slice(1);
    for (const field of fields.join('').split(',')) {
      if (/^(?:\d{1,3}\.){3}\d{1,3}\/32$/.test(field) && ipv4Number(field.slice(0, field.indexOf('/'))) !== null) {
        addresses.add(field);
      }
    }
  }
  return [...addresses].sort();
}

function looksLikeVpnInterface(name) {
  return /^(?:awg|wg|tun|tap)[a-z0-9_.-]*$/i.test(name);
}

async function readAllowedIps(runner, container, interfaceName) {
  for (const utility of ['awg', 'wg']) {
    try {
      return parsePeerAddresses(await runner('docker', ['exec', container, utility, 'show', interfaceName, 'allowed-ips']));
    } catch {
      // The alternative utility may be available in the container.
    }
  }
  return [];
}

export async function discoverAmneziaSources({ runner = defaultRunner } = {}) {
  let containers;
  try {
    containers = parseDockerRows(await runner('docker', ['ps', '--format', '{{json .}}']));
  } catch (error) {
    throw new Error(`Docker discovery failed: ${error.message}`);
  }

  const candidates = [];
  for (const container of containers) {
    const name = container.Names || container.Name;
    const image = container.Image || '';
    if (!name) continue;
    let interfaces;
    try {
      interfaces = JSON.parse(await runner('docker', ['exec', name, 'ip', '-j', '-4', 'addr', 'show']));
    } catch {
      continue;
    }
    for (const item of interfaces) {
      if (!item.ifname || item.ifname === 'lo') continue;
      if (!looksLikeVpnInterface(item.ifname)) continue;
      for (const address of item.addr_info || []) {
        if (address.family !== 'inet' || address.scope === 'host') continue;
        const subnet = networkCidr(address.local, address.prefixlen);
        if (!subnet) continue;
        candidates.push({
          source_type: 'amneziawg2_container',
          container_name: name,
          container_image: image,
          interface: item.ifname,
          interface_address: `${address.local}/${address.prefixlen}`,
          client_subnet: subnet,
          client_addresses: await readAllowedIps(runner, name, item.ifname)
        });
      }
    }
  }
  return candidates;
}
