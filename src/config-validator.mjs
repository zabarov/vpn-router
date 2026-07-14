import { isIP } from 'node:net';

const tagPattern = /^[a-z][a-z0-9-]{1,62}$/;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{2,127}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueTags(items, label, errors) {
  const values = new Set();
  for (const item of items) {
    if (!isObject(item) || !tagPattern.test(item.tag ?? '')) {
      errors.push(`${label} has an invalid tag`);
      continue;
    }
    if (values.has(item.tag)) errors.push(`${label} tag is duplicated: ${item.tag}`);
    values.add(item.tag);
  }
  return values;
}

function validCidr(value) {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...extra] = value.split('/');
  if (extra.length || !address || !prefix || !isIP(address)) return false;
  const maxPrefix = isIP(address) === 4 ? 32 : 128;
  return Number.isInteger(Number(prefix)) && Number(prefix) >= 0 && Number(prefix) <= maxPrefix;
}

function validDomainSuffix(value) {
  return typeof value === 'string' && /^\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);
}

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return { valid: false, errors: ['configuration must be a YAML object'] };
  if (config.schema_version !== '1.0') errors.push('schema_version must be "1.0"');

  for (const key of ['sources', 'egresses', 'policies']) {
    if (!Array.isArray(config[key]) || config[key].length === 0) errors.push(`${key} must be a non-empty list`);
  }
  if (errors.length) return { valid: false, errors };

  if (!isObject(config.capture) || config.capture.type !== 'tproxy' || !Number.isInteger(config.capture.listen_port) || config.capture.listen_port < 1024 || config.capture.listen_port > 65535) {
    errors.push('capture must declare tproxy with a non-privileged listen_port');
  }

  if (!isObject(config.destination_sets)) {
    errors.push('destination_sets must be an object');
  } else {
    for (const [name, destinationSet] of Object.entries(config.destination_sets)) {
      if (!isObject(destinationSet)) {
        errors.push(`destination set ${name} must be an object`);
        continue;
      }
      const cidrs = destinationSet.ip_cidrs ?? [];
      const suffixes = destinationSet.domain_suffixes ?? [];
      if ((!Array.isArray(cidrs) || cidrs.length === 0) && (!Array.isArray(suffixes) || suffixes.length === 0)) {
        errors.push(`destination set ${name} requires ip_cidrs or domain_suffixes`);
      }
      if (!Array.isArray(cidrs) || cidrs.some((cidr) => !validCidr(cidr))) errors.push(`destination set ${name} has an invalid ip_cidrs entry`);
      if (!Array.isArray(suffixes) || suffixes.some((suffix) => !validDomainSuffix(suffix))) errors.push(`destination set ${name} has an invalid domain_suffixes entry`);
    }
  }

  const sourceTags = uniqueTags(config.sources, 'source', errors);
  const egressTags = uniqueTags(config.egresses, 'egress', errors);
  uniqueTags(config.policies, 'policy', errors);

  for (const source of config.sources) {
    if (!isObject(source)) continue;
    if (source.type !== 'amneziawg2_container') errors.push(`source ${source.tag ?? '<unknown>'} has an unsupported type`);
    if (typeof source.container_name !== 'string' || source.container_name.length === 0) errors.push(`source ${source.tag ?? '<unknown>'} requires container_name`);
    if (typeof source.interface !== 'string' || source.interface.length === 0) errors.push(`source ${source.tag ?? '<unknown>'} requires interface`);
    if (!validCidr(source.client_subnet)) errors.push(`source ${source.tag ?? '<unknown>'} has an invalid client_subnet`);
  }

  for (const egress of config.egresses) {
    if (!isObject(egress)) continue;
    if (!['direct', 'tailscale_socks'].includes(egress.type)) errors.push(`egress ${egress.tag ?? '<unknown>'} has an unsupported type`);
    if (egress.type === 'tailscale_socks') {
      if (!environmentNamePattern.test(egress.auth_key_env ?? '')) errors.push(`Tailscale egress ${egress.tag} requires auth_key_env, not a credential value`);
      if (typeof egress.exit_node !== 'string' || egress.exit_node.length === 0) errors.push(`Tailscale egress ${egress.tag} requires exit_node`);
      if (typeof egress.proxy_server !== 'string' || egress.proxy_server.length === 0) errors.push(`Tailscale egress ${egress.tag} requires proxy_server`);
      if (!Number.isInteger(egress.proxy_port) || egress.proxy_port < 1 || egress.proxy_port > 65535) errors.push(`Tailscale egress ${egress.tag} requires proxy_port`);
    }
  }

  for (const policy of config.policies) {
    if (!isObject(policy)) continue;
    if (!sourceTags.has(policy.source)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown source`);
    if (!egressTags.has(policy.egress)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown egress`);
    if (!Array.isArray(policy.destination_sets) || policy.destination_sets.length === 0) {
      errors.push(`policy ${policy.tag ?? '<unknown>'} requires destination_sets`);
    } else {
      for (const destinationSet of policy.destination_sets) {
        if (destinationSet !== 'default' && !Object.hasOwn(config.destination_sets ?? {}, destinationSet)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown destination set: ${destinationSet}`);
      }
    }
    if (!['block', 'direct'].includes(policy.failure_mode)) errors.push(`policy ${policy.tag ?? '<unknown>'} requires failure_mode block or direct`);
    const egress = config.egresses.find((candidate) => candidate.tag === policy.egress);
    if (policy.failure_mode === 'block' && egress?.type === 'direct') errors.push(`strict policy ${policy.tag ?? '<unknown>'} cannot use direct egress`);
  }

  const handling = config.traffic_handling;
  if (!isObject(handling)) {
    errors.push('traffic_handling must be an object');
  } else {
    for (const key of ['udp_quic', 'ipv6']) {
      if (!['reject', 'bypass', 'require_supported'].includes(handling[key])) errors.push(`traffic_handling.${key} must be explicit`);
    }
    if (!['managed', 'system'].includes(handling.dns_mode)) errors.push('traffic_handling.dns_mode must be managed or system');
    if (config.policies.some((policy) => policy.failure_mode === 'block') && (handling.udp_quic === 'bypass' || handling.ipv6 === 'bypass')) {
      errors.push('strict policies cannot use bypass for udp_quic or ipv6');
    }
  }

  const resources = config.resources;
  if (!isObject(resources)) {
    errors.push('resources must be an object');
  } else {
    for (const key of ['nftables_table', 'routing_mark', 'routing_mask', 'route_table', 'rule_priority', 'service_name']) {
      if (resources[key] === undefined || resources[key] === '') errors.push(`resources.${key} is required`);
    }
    if (!Number.isInteger(resources.routing_mark) || resources.routing_mark < 1) errors.push('resources.routing_mark must be a positive integer');
    if (!Number.isInteger(resources.routing_mask) || resources.routing_mask < 1) errors.push('resources.routing_mask must be a positive integer');
    if (!Number.isInteger(resources.route_table) || resources.route_table < 1) errors.push('resources.route_table must be a positive integer');
    if (!Number.isInteger(resources.rule_priority) || resources.rule_priority < 1) errors.push('resources.rule_priority must be a positive integer');
  }

  return { valid: errors.length === 0, errors };
}
