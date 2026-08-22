import { execFileSync } from 'node:child_process';
import { buildRuntimePlan } from './runtime-plan.mjs';

const EXEC_OPTIONS = {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 5_000
};

function collectSetNames(value, result = new Set()) {
  if (typeof value === 'string' && value.startsWith('@')) result.add(value.slice(1));
  else if (Array.isArray(value)) for (const item of value) collectSetNames(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectSetNames(item, result);
  return result;
}

export function summarizeNftCounters(payload) {
  const result = { packets: 0, bytes: 0, selector_sets: {} };
  for (const item of payload?.nftables ?? []) {
    const expressions = item?.rule?.expr;
    if (!Array.isArray(expressions)) continue;
    const counter = expressions.find((expression) => expression?.counter)?.counter;
    if (!counter) continue;
    const packets = Number(counter.packets ?? 0);
    const bytes = Number(counter.bytes ?? 0);
    result.packets += Number.isFinite(packets) ? packets : 0;
    result.bytes += Number.isFinite(bytes) ? bytes : 0;
    for (const setName of collectSetNames(expressions)) {
      const current = result.selector_sets[setName] ?? { packets: 0, bytes: 0 };
      current.packets += Number.isFinite(packets) ? packets : 0;
      current.bytes += Number.isFinite(bytes) ? bytes : 0;
      result.selector_sets[setName] = current;
    }
  }
  return result;
}

function executeJson(execute, file, args) {
  return JSON.parse(execute(file, args, EXEC_OPTIONS));
}

function nftPayload(execute, group, table) {
  if (group.namespace === 'host') return executeJson(execute, 'nft', ['-j', 'list', 'table', 'inet', table]);
  const inspected = executeJson(execute, 'docker', ['inspect', group.container_name]);
  const pid = inspected?.[0]?.State?.Pid;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('source namespace is not running');
  return executeJson(execute, 'nsenter', ['--target', String(pid), '--net', '--', 'nft', '-j', 'list', 'table', 'inet', table]);
}

function egressState(execute, plan) {
  if (plan.strict_egress.type !== 'tailscale_socks') {
    return {
      type: plan.strict_egress.type,
      status: 'EXTERNAL_MANAGED',
      detail: 'Reachability is checked by vpn-router verify --full.'
    };
  }
  try {
    const inspected = executeJson(execute, 'docker', ['inspect', plan.egress_name]);
    const container = inspected?.[0];
    const owned = container?.Config?.Labels?.['io.github.rim.vpn-router.owner'] === plan.service_name;
    if (!container?.State?.Running || !owned) return { type: 'tailscale_socks', status: 'FAILED', detail: 'Managed egress is stopped, missing, or not owned.' };
    const tailscale = executeJson(execute, 'docker', ['exec', plan.egress_name, 'tailscale', 'status', '--json']);
    const ready = tailscale?.BackendState === 'Running' && tailscale?.ExitNodeStatus?.Online === true;
    return {
      type: 'tailscale_socks',
      status: ready ? 'READY' : 'FAILED',
      detail: ready ? 'Tailscale is running and the configured exit node is online.' : 'Tailscale or its configured exit node is not ready.'
    };
  } catch {
    return { type: 'tailscale_socks', status: 'UNAVAILABLE', detail: 'Managed egress state could not be read.' };
  }
}

export function collectRuntimeDiagnostics(config, options = {}) {
  const execute = options.execute ?? execFileSync;
  const plan = buildRuntimePlan(config);
  const packetCounters = [];
  for (const group of plan.groups) {
    try {
      packetCounters.push({ source_group: group.tag, status: 'AVAILABLE', ...summarizeNftCounters(nftPayload(execute, group, plan.nftables_table)) });
    } catch {
      packetCounters.push({ source_group: group.tag, status: 'UNAVAILABLE', packets: null, bytes: null, selector_sets: {} });
    }
  }
  return {
    routing_state: packetCounters.every((item) => item.status === 'AVAILABLE') ? 'APPLIED' : 'UNAVAILABLE',
    egress: egressState(execute, plan),
    packet_counters: packetCounters
  };
}
