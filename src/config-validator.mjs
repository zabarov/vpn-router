import { isIP } from 'node:net';
import { normalizeConfig, policySources } from './config-normalizer.mjs';

const tagPattern = /^[a-z][a-z0-9-]{1,62}$/;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{2,127}$/;
const interfaceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/;
const containerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const networkAddressPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/;
const nftablesTablePattern = /^[a-z][a-z0-9_]{2,31}$/;
const serviceNamePattern = /^[a-z][a-z0-9-]{2,63}$/;

const rootFields = new Set(['schema_version', 'routing_data', 'sources', 'capture', 'egresses', 'policies', 'destination_sets', 'traffic_handling', 'resources']);
const captureFields = new Set(['type', 'listen_port']);
const destinationSetFields = new Set(['ip_cidrs', 'country_codes', 'exact_domains', 'domain_suffixes']);
const routingDataFields = new Set(['country_provider', 'domain_resolver']);
const countryProviderFields = new Set(['type', 'refresh_interval', 'max_stale']);
const domainResolverFields = new Set(['refresh_interval', 'min_ttl', 'max_ttl', 'max_stale']);
const amneziaSourceFields = new Set(['tag', 'type', 'container_name', 'interface', 'client_subnet', 'client_scope']);
const linuxSourceFields = new Set(['tag', 'type', 'interface', 'client_subnet', 'client_scope']);
const tunnelSourceFields = new Set(['tag', 'type', 'namespace', 'container_name', 'interface', 'clients']);
const containerEgressSourceFields = new Set(['tag', 'type', 'container_name', 'clients']);
const clientScopeFields = new Set(['mode', 'addresses', 'subnet']);
const directEgressFields = new Set(['tag', 'type']);
const tailscaleEgressFields = new Set(['tag', 'type', 'auth_key_env', 'exit_node', 'proxy_server', 'proxy_port', 'healthcheck_url']);
const socksEgressFields = new Set(['tag', 'type', 'server', 'port', 'healthcheck_url']);
const interfaceEgressFields = new Set(['tag', 'type', 'interface', 'healthcheck_url']);
const legacyPolicyFields = new Set(['tag', 'source', 'destination_sets', 'egress', 'failure_mode']);
const policyFields = new Set(['tag', 'sources', 'destination_sets', 'egress', 'failure_mode']);
const trafficHandlingFields = new Set(['udp_quic', 'ipv6', 'dns_mode']);
const resourceFields = new Set(['nftables_table', 'service_name']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowedFields, label, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) errors.push(`${label} has an unsupported field: ${key}`);
  }
}

function rejectDuplicates(values, label, errors) {
  if (Array.isArray(values) && new Set(values).size !== values.length) errors.push(`${label} must not contain duplicates`);
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

function validIpv4Cidr(value) {
  return validCidr(value) && isIP(value.split('/')[0]) === 4;
}

function isSingleHostIpv4Cidr(value) {
  return validIpv4Cidr(value) && value.endsWith('/32');
}

function isCanonicalIpv4Subnet(value) {
  if (!validIpv4Cidr(value)) return false;
  const [address, prefixText] = value.split('/');
  const prefix = Number(prefixText);
  const numeric = address.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (numeric & mask) === numeric;
}

function validateClientScope(source, errors) {
  const label = `source ${source.tag ?? '<unknown>'}`;
  if (source.type === 'container_egress') {
    if (!isObject(source.clients) || source.clients.mode !== 'all' || Object.keys(source.clients).some((key) => key !== 'mode')) {
      errors.push(`${label} container_egress clients must declare only mode all`);
    }
    return;
  }
  if (source.clients !== undefined) {
    if (!isObject(source.clients)) {
      errors.push(`${label} clients must be an object`);
      return;
    }
    const compatibilitySource = { ...source, client_scope: source.clients };
    delete compatibilitySource.clients;
    validateClientScope(compatibilitySource, errors);
    return;
  }
  const hasLegacyScope = source.client_subnet !== undefined;
  const hasClientScope = source.client_scope !== undefined;
  if (hasLegacyScope === hasClientScope) {
    errors.push(`${label} must declare exactly one of client_scope or legacy client_subnet`);
    return;
  }
  if (hasLegacyScope) {
    if (!isSingleHostIpv4Cidr(source.client_subnet)) errors.push(`${label} legacy client_subnet must be one IPv4 host (/32)`);
    return;
  }
  if (!isObject(source.client_scope)) {
    errors.push(`${label} client_scope must be an object`);
    return;
  }
  const scope = source.client_scope;
  rejectUnknownKeys(scope, clientScopeFields, `${label} client_scope`, errors);
  if (scope.mode === 'address_list') {
    if (!Array.isArray(scope.addresses) || scope.addresses.length === 0 || scope.addresses.some((cidr) => !isSingleHostIpv4Cidr(cidr))) {
      errors.push(`${label} address_list requires one or more IPv4 host (/32) addresses`);
    }
    rejectDuplicates(scope.addresses, `${label} client_scope.addresses`, errors);
    if (scope.subnet !== undefined) errors.push(`${label} address_list cannot declare subnet`);
    return;
  }
  if (scope.mode === 'subnet') {
    if (!isCanonicalIpv4Subnet(scope.subnet) || scope.subnet === '0.0.0.0/0') errors.push(`${label} subnet requires a canonical, explicit IPv4 VPN CIDR and cannot use 0.0.0.0/0`);
    if (scope.addresses !== undefined) errors.push(`${label} subnet cannot declare addresses`);
    return;
  }
  errors.push(`${label} client_scope.mode must be address_list or subnet`);
}

function validDomainSuffix(value) {
  if (typeof value !== 'string' || !value.startsWith('.') || value.length > 254) return false;
  return value.slice(1).split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validExactDomain(value) {
  if (typeof value !== 'string' || value.startsWith('.') || value.length > 253) return false;
  return value.split('.').length > 1 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validDuration(value) {
  return typeof value === 'string' && /^[1-9][0-9]*(?:m|h|d)$/.test(value);
}

function durationMinutes(value) {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2]];
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}

export function validateConfig(input) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: ['configuration must be a YAML object'] };
  rejectUnknownKeys(input, rootFields, 'configuration', errors);
  if (!['1.0', '2.0', '3.0'].includes(input.schema_version)) errors.push('schema_version must be "1.0", "2.0", or "3.0"');
  if (input.schema_version === '1.0') {
    for (const source of input.sources ?? []) {
      if (!isObject(source)) continue;
      if (!['amneziawg2_container', 'linux_interface'].includes(source.type)) errors.push(`source ${source.tag ?? '<unknown>'} has an unsupported type`);
      if (source.type === 'amneziawg2_container') rejectUnknownKeys(source, amneziaSourceFields, `source ${source.tag ?? '<unknown>'}`, errors);
      if (source.type === 'linux_interface') rejectUnknownKeys(source, linuxSourceFields, `source ${source.tag ?? '<unknown>'}`, errors);
      validateClientScope(source, errors);
    }
    for (const policy of input.policies ?? []) rejectUnknownKeys(policy, legacyPolicyFields, `policy ${policy?.tag ?? '<unknown>'}`, errors);
  }
  const config = normalizeConfig(input);
  if (!isObject(config)) return { valid: false, errors: ['configuration must be a YAML object'] };
  if (!['2.0', '3.0'].includes(config.schema_version)) return { valid: false, errors };

  let requiredListsAreUsable = true;
  for (const key of ['sources', 'egresses', 'policies']) {
    if (!Array.isArray(config[key]) || config[key].length === 0) {
      errors.push(`${key} must be a non-empty list`);
      requiredListsAreUsable = false;
    }
  }
  if (!requiredListsAreUsable) return { valid: false, errors };

  if (config.schema_version === '2.0' && config.policies.length !== 2) errors.push('schema 2 requires exactly one strict policy and one default-direct policy');
  if (config.schema_version === '3.0' && (config.policies.length < 2 || config.policies.length > 3)) errors.push('schema 3 requires one strict policy, one default-direct policy, and at most one direct-override policy');

  const routingData = config.routing_data;
  if (routingData !== undefined) {
    if (!isObject(routingData)) {
      errors.push('routing_data must be an object');
    } else {
      rejectUnknownKeys(routingData, routingDataFields, 'routing_data', errors);
      if (routingData.country_provider !== undefined) {
        const provider = routingData.country_provider;
        if (!isObject(provider)) errors.push('routing_data.country_provider must be an object');
        else {
          rejectUnknownKeys(provider, countryProviderFields, 'routing_data.country_provider', errors);
          if (provider.type !== 'ripestat') errors.push('routing_data.country_provider.type must be ripestat');
          if (!validDuration(provider.refresh_interval)) errors.push('routing_data.country_provider.refresh_interval must be a duration such as 24h');
          if (!validDuration(provider.max_stale)) errors.push('routing_data.country_provider.max_stale must be a duration such as 7d');
          if (durationMinutes(provider.refresh_interval) !== null && durationMinutes(provider.max_stale) !== null && durationMinutes(provider.max_stale) < durationMinutes(provider.refresh_interval)) errors.push('routing_data.country_provider.max_stale cannot be shorter than refresh_interval');
        }
      }
      if (routingData.domain_resolver !== undefined) {
        const resolver = routingData.domain_resolver;
        if (!isObject(resolver)) errors.push('routing_data.domain_resolver must be an object');
        else {
          rejectUnknownKeys(resolver, domainResolverFields, 'routing_data.domain_resolver', errors);
          if (!validDuration(resolver.refresh_interval)) errors.push('routing_data.domain_resolver.refresh_interval must be a duration such as 5m');
          if (!Number.isInteger(resolver.min_ttl) || resolver.min_ttl < 30 || resolver.min_ttl > 86400) errors.push('routing_data.domain_resolver.min_ttl must be an integer between 30 and 86400');
          if (!Number.isInteger(resolver.max_ttl) || resolver.max_ttl < 60 || resolver.max_ttl > 604800) errors.push('routing_data.domain_resolver.max_ttl must be an integer between 60 and 604800');
          if (Number.isInteger(resolver.min_ttl) && Number.isInteger(resolver.max_ttl) && resolver.min_ttl > resolver.max_ttl) errors.push('routing_data.domain_resolver.min_ttl cannot exceed max_ttl');
          if (!validDuration(resolver.max_stale)) errors.push('routing_data.domain_resolver.max_stale must be a duration such as 24h');
          if (durationMinutes(resolver.refresh_interval) !== null && durationMinutes(resolver.max_stale) !== null && durationMinutes(resolver.max_stale) < durationMinutes(resolver.refresh_interval)) errors.push('routing_data.domain_resolver.max_stale cannot be shorter than refresh_interval');
        }
      }
    }
  }

  if (!isObject(config.capture) || config.capture.type !== 'redirect' || !Number.isInteger(config.capture.listen_port) || config.capture.listen_port < 1024 || config.capture.listen_port > 65535) {
    errors.push('capture must declare redirect with a non-privileged listen_port');
  }
  rejectUnknownKeys(config.capture, captureFields, 'capture', errors);

  if (!isObject(config.destination_sets)) {
    errors.push('destination_sets must be an object');
  } else {
    for (const [name, destinationSet] of Object.entries(config.destination_sets)) {
      if (!tagPattern.test(name)) errors.push(`destination set has an invalid name: ${JSON.stringify(name)}`);
      if (!isObject(destinationSet)) {
        errors.push(`destination set ${name} must be an object`);
        continue;
      }
      rejectUnknownKeys(destinationSet, destinationSetFields, `destination set ${name}`, errors);
      const cidrs = destinationSet.ip_cidrs ?? [];
      const countries = destinationSet.country_codes ?? [];
      const domains = destinationSet.exact_domains ?? [];
      const suffixes = destinationSet.domain_suffixes ?? [];
      if ([cidrs, countries, domains, suffixes].every((items) => !Array.isArray(items) || items.length === 0)) {
        errors.push(`destination set ${name} requires at least one non-empty selector`);
      }
      if (!Array.isArray(cidrs) || cidrs.some((cidr) => !validIpv4Cidr(cidr))) errors.push(`destination set ${name} has an invalid IPv4 ip_cidrs entry`);
      if (!Array.isArray(countries) || countries.some((country) => typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))) errors.push(`destination set ${name} has an invalid ISO country_codes entry`);
      if (!Array.isArray(domains) || domains.some((domain) => !validExactDomain(domain))) errors.push(`destination set ${name} has an invalid exact_domains entry`);
      if (!Array.isArray(suffixes) || suffixes.some((suffix) => !validDomainSuffix(suffix))) errors.push(`destination set ${name} has an invalid domain_suffixes entry`);
      rejectDuplicates(cidrs, `destination set ${name} ip_cidrs`, errors);
      rejectDuplicates(countries, `destination set ${name} country_codes`, errors);
      rejectDuplicates(domains, `destination set ${name} exact_domains`, errors);
      rejectDuplicates(suffixes, `destination set ${name} domain_suffixes`, errors);
    }
  }

  const destinationValues = Object.values(config.destination_sets ?? {}).filter(isObject);
  const needsCountryData = destinationValues.some((destination) => (destination.country_codes ?? []).length > 0);
  const needsDomainData = destinationValues.some((destination) => (destination.exact_domains ?? []).length > 0);
  if ((needsCountryData || needsDomainData) && config.schema_version !== '3.0') errors.push('country_codes and exact_domains require schema_version 3.0');
  if (needsCountryData && !isObject(routingData?.country_provider)) errors.push('country_codes require routing_data.country_provider');
  if (needsDomainData && !isObject(routingData?.domain_resolver)) errors.push('exact_domains require routing_data.domain_resolver');

  const sourceTags = uniqueTags(config.sources, 'source', errors);
  const egressTags = uniqueTags(config.egresses, 'egress', errors);
  uniqueTags(config.policies, 'policy', errors);

  for (const source of config.sources) {
    if (!isObject(source)) continue;
    if (!['tunnel_interface', 'container_egress'].includes(source.type)) errors.push(`source ${source.tag ?? '<unknown>'} has an unsupported type`);
    if (source.type === 'tunnel_interface') rejectUnknownKeys(source, tunnelSourceFields, `source ${source.tag ?? '<unknown>'}`, errors);
    if (source.type === 'container_egress') rejectUnknownKeys(source, containerEgressSourceFields, `source ${source.tag ?? '<unknown>'}`, errors);
    if (source.type === 'tunnel_interface' && !['host', 'container'].includes(source.namespace)) {
      errors.push(`source ${source.tag ?? '<unknown>'} namespace must be host or container`);
    }
    const needsContainer = source.type === 'container_egress' || source.namespace === 'container';
    if (needsContainer && !containerNamePattern.test(source.container_name ?? '')) errors.push(`source ${source.tag ?? '<unknown>'} requires container_name`);
    if (!needsContainer && source.container_name !== undefined) errors.push(`source ${source.tag ?? '<unknown>'} host namespace cannot declare container_name`);
    if (source.type === 'tunnel_interface' && !interfaceNamePattern.test(source.interface ?? '')) errors.push(`source ${source.tag ?? '<unknown>'} requires a valid Linux interface name`);
    if (source.type === 'container_egress' && source.interface !== undefined) errors.push(`source ${source.tag ?? '<unknown>'} container_egress cannot declare interface`);
    validateClientScope(source, errors);
  }
  const sourceIdentities = new Set();
  const containerNamespaces = new Set();
  for (const source of config.sources.filter(isObject)) {
    const identity = source.type === 'container_egress'
      ? `container-egress:${source.container_name}`
      : `${source.namespace}:${source.container_name ?? 'host'}:${source.interface}`;
    if (sourceIdentities.has(identity)) errors.push(`source runtime identity is duplicated: ${identity}`);
    sourceIdentities.add(identity);
    if (source.container_name) {
      if (containerNamespaces.has(source.container_name)) errors.push(`container namespace is assigned to more than one source: ${source.container_name}`);
      containerNamespaces.add(source.container_name);
    }
  }

  for (const egress of config.egresses) {
    if (!isObject(egress)) continue;
    if (!['direct', 'tailscale_socks', 'socks5', 'linux_interface'].includes(egress.type)) errors.push(`egress ${egress.tag ?? '<unknown>'} has an unsupported type`);
    if (egress.type === 'direct') rejectUnknownKeys(egress, directEgressFields, `egress ${egress.tag ?? '<unknown>'}`, errors);
    if (egress.type === 'tailscale_socks') rejectUnknownKeys(egress, tailscaleEgressFields, `egress ${egress.tag ?? '<unknown>'}`, errors);
    if (egress.type === 'socks5') rejectUnknownKeys(egress, socksEgressFields, `egress ${egress.tag ?? '<unknown>'}`, errors);
    if (egress.type === 'linux_interface') rejectUnknownKeys(egress, interfaceEgressFields, `egress ${egress.tag ?? '<unknown>'}`, errors);
    if (egress.type === 'tailscale_socks') {
      if (!environmentNamePattern.test(egress.auth_key_env ?? '')) errors.push(`Tailscale egress ${egress.tag} requires auth_key_env, not a credential value`);
      if (!networkAddressPattern.test(egress.exit_node ?? '')) errors.push(`Tailscale egress ${egress.tag} requires exit_node`);
      if (!networkAddressPattern.test(egress.proxy_server ?? '')) errors.push(`Tailscale egress ${egress.tag} requires proxy_server`);
      if (!Number.isInteger(egress.proxy_port) || egress.proxy_port < 1 || egress.proxy_port > 65535) errors.push(`Tailscale egress ${egress.tag} requires proxy_port`);
      if (!validHttpsUrl(egress.healthcheck_url)) errors.push(`Tailscale egress ${egress.tag} requires a credential-free HTTPS healthcheck_url`);
    }
    if (egress.type === 'socks5') {
      if (!networkAddressPattern.test(egress.server ?? '')) errors.push(`SOCKS5 egress ${egress.tag} requires server`);
      if (!Number.isInteger(egress.port) || egress.port < 1 || egress.port > 65535) errors.push(`SOCKS5 egress ${egress.tag} requires port`);
      if (!validHttpsUrl(egress.healthcheck_url)) errors.push(`SOCKS5 egress ${egress.tag} requires a credential-free HTTPS healthcheck_url`);
    }
    if (egress.type === 'linux_interface') {
      if (!interfaceNamePattern.test(egress.interface ?? '')) errors.push(`Linux interface egress ${egress.tag} requires a valid interface name`);
      if (!validHttpsUrl(egress.healthcheck_url)) errors.push(`Linux interface egress ${egress.tag} requires a credential-free HTTPS healthcheck_url`);
    }
  }
  const directEgresses = config.egresses.filter((egress) => isObject(egress) && egress.type === 'direct');
  const strictEgresses = config.egresses.filter((egress) => isObject(egress) && ['tailscale_socks', 'socks5', 'linux_interface'].includes(egress.type));
  if (directEgresses.length !== 1 || strictEgresses.length !== 1) {
    errors.push('the IPv4/TCP MVP requires exactly one direct and one supported strict egress');
  }

  for (const policy of config.policies) {
    if (!isObject(policy)) continue;
    rejectUnknownKeys(policy, policyFields, `policy ${policy.tag ?? '<unknown>'}`, errors);
    const selectedSources = policySources(policy, config);
    if (!Array.isArray(selectedSources) || selectedSources.length === 0) {
      errors.push(`policy ${policy.tag ?? '<unknown>'} sources must be a non-empty list when declared`);
    } else {
      rejectDuplicates(selectedSources, `policy ${policy.tag ?? '<unknown>'} sources`, errors);
      for (const source of selectedSources) if (!sourceTags.has(source)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown source: ${source}`);
    }
    if (!egressTags.has(policy.egress)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown egress`);
    if (!Array.isArray(policy.destination_sets) || policy.destination_sets.length === 0) {
      errors.push(`policy ${policy.tag ?? '<unknown>'} requires destination_sets`);
    } else {
      rejectDuplicates(policy.destination_sets, `policy ${policy.tag ?? '<unknown>'} destination_sets`, errors);
      for (const destinationSet of policy.destination_sets) {
        if (destinationSet !== 'default' && !Object.hasOwn(config.destination_sets ?? {}, destinationSet)) errors.push(`policy ${policy.tag ?? '<unknown>'} references an unknown destination set: ${destinationSet}`);
      }
    }
    if (!['block', 'direct'].includes(policy.failure_mode)) errors.push(`policy ${policy.tag ?? '<unknown>'} requires failure_mode block or direct`);
    const egress = config.egresses.find((candidate) => candidate.tag === policy.egress);
    if (policy.failure_mode === 'block' && egress?.type === 'direct') errors.push(`strict policy ${policy.tag ?? '<unknown>'} cannot use direct egress`);
    if (policy.destination_sets?.includes('default') && policy.destination_sets.length !== 1) errors.push(`policy ${policy.tag ?? '<unknown>'} cannot combine default with another destination set`);
    if (policy.failure_mode === 'direct' && !policy.destination_sets?.includes('default')) {
      if (config.schema_version !== '3.0') errors.push(`non-default policy ${policy.tag ?? '<unknown>'} cannot use failure_mode direct before schema 3`);
      if (egress?.type !== 'direct') errors.push(`direct-override policy ${policy.tag ?? '<unknown>'} must use the direct egress`);
      for (const setName of policy.destination_sets ?? []) {
        const destination = config.destination_sets?.[setName];
        if ((destination?.country_codes ?? []).length > 0 || (destination?.domain_suffixes ?? []).length > 0) {
          errors.push(`direct-override policy ${policy.tag ?? '<unknown>'} supports only ip_cidrs and exact_domains`);
        }
      }
    }
  }

  const strictPolicies = config.policies.filter((policy) => isObject(policy) && policy.failure_mode === 'block');
  const defaultPolicies = config.policies.filter((policy) => isObject(policy) && policy.destination_sets?.length === 1 && policy.destination_sets[0] === 'default');
  const directOverridePolicies = config.policies.filter((policy) => isObject(policy) && policy.failure_mode === 'direct' && !policy.destination_sets?.includes('default'));
  if (strictPolicies.length !== 1) errors.push('the IPv4/TCP MVP requires exactly one strict policy');
  if (defaultPolicies.length !== 1) errors.push('the IPv4/TCP MVP requires exactly one default policy');
  if (directOverridePolicies.length > 1) errors.push('schema 3 supports at most one direct-override policy');

  const strictPolicy = strictPolicies[0];
  if (strictPolicy) {
    if (strictPolicy.destination_sets?.includes('default')) errors.push(`strict policy ${strictPolicy.tag ?? '<unknown>'} cannot target default`);
    const strictEgress = config.egresses.find((candidate) => candidate.tag === strictPolicy.egress);
    if (strictEgress && !['tailscale_socks', 'socks5', 'linux_interface'].includes(strictEgress.type)) errors.push(`strict policy ${strictPolicy.tag ?? '<unknown>'} must use a supported strict egress`);
  }

  const defaultPolicy = defaultPolicies[0];
  if (defaultPolicy) {
    const defaultEgress = config.egresses.find((candidate) => candidate.tag === defaultPolicy.egress);
    if (defaultPolicy.failure_mode !== 'direct' || defaultEgress?.type !== 'direct') errors.push(`default policy ${defaultPolicy.tag ?? '<unknown>'} must use a direct egress with failure_mode direct`);
  }
  if (strictPolicy && defaultPolicy) {
    const strictSources = [...policySources(strictPolicy, config)].sort();
    const defaultSources = [...policySources(defaultPolicy, config)].sort();
    if (JSON.stringify(strictSources) !== JSON.stringify(defaultSources)) errors.push('strict and default policies must reference the same sources');
  }
  if (directOverridePolicies[0] && strictPolicy) {
    const directSources = [...policySources(directOverridePolicies[0], config)].sort();
    const strictSources = [...policySources(strictPolicy, config)].sort();
    if (JSON.stringify(directSources) !== JSON.stringify(strictSources)) errors.push('direct-override and strict policies must reference the same sources');
  }
  if (config.schema_version === '3.0' && defaultPolicy && config.policies.at(-1) !== defaultPolicy) errors.push('the default-direct policy must be last');
  if (directOverridePolicies[0] && strictPolicy && config.policies.indexOf(directOverridePolicies[0]) > config.policies.indexOf(strictPolicy)) errors.push('the direct-override policy must precede the strict policy');
  const activeStrictEgress = strictEgresses[0];
  if (activeStrictEgress?.type === 'linux_interface') {
    for (const source of config.sources.filter((candidate) => candidate.type === 'tunnel_interface' && candidate.namespace === 'host')) {
      if (source.interface === activeStrictEgress.interface) errors.push(`source ${source.tag} and strict egress interfaces must be different`);
    }
  }
  const referencedEgresses = new Set(config.policies.filter(isObject).map((policy) => policy.egress));
  for (const egress of config.egresses.filter(isObject)) {
    if (!referencedEgresses.has(egress.tag)) errors.push(`egress ${egress.tag ?? '<unknown>'} is not referenced by a policy`);
  }

  const handling = config.traffic_handling;
  if (!isObject(handling)) {
    errors.push('traffic_handling must be an object');
  } else {
    rejectUnknownKeys(handling, trafficHandlingFields, 'traffic_handling', errors);
    for (const key of ['udp_quic', 'ipv6']) {
      if (handling[key] !== 'reject') errors.push(`traffic_handling.${key} must be reject in the IPv4/TCP MVP`);
    }
    if (!['managed', 'system'].includes(handling.dns_mode)) errors.push('traffic_handling.dns_mode must be managed or system');
    const hasStrictDomains = strictPolicies.some((policy) => (policy.destination_sets ?? []).some((name) => name !== 'default' && (config.destination_sets?.[name]?.domain_suffixes ?? []).length > 0));
    if (hasStrictDomains && handling.dns_mode !== 'managed') {
      errors.push('strict domain policies require traffic_handling.dns_mode managed');
    }
  }

  const resources = config.resources;
  if (!isObject(resources)) {
    errors.push('resources must be an object');
  } else {
    rejectUnknownKeys(resources, resourceFields, 'resources', errors);
    for (const key of ['nftables_table', 'service_name']) {
      if (resources[key] === undefined || resources[key] === '') errors.push(`resources.${key} is required`);
    }
    if (!nftablesTablePattern.test(resources.nftables_table ?? '')) errors.push('resources.nftables_table has an invalid name');
    if (!serviceNamePattern.test(resources.service_name ?? '')) errors.push('resources.service_name has an invalid name');
  }

  return { valid: errors.length === 0, errors };
}
