import { validateConfig } from './config-validator.mjs';
import { normalizeConfig, policySources, sourceClientScope, sourceClientSetName, sourceNamespace } from './config-normalizer.mjs';

export const CAPTURE_ROUTING_MARK = 0x5254;
export const MANAGED_DNS_UID = 65534;

function setName(tag) {
  return `set_${tag.replaceAll('-', '_')}`;
}

function staticSetName(tag) {
  return `${setName(tag)}_static`;
}

function dnsSetName(tag) {
  return `${setName(tag)}_dns`;
}

function namespaceKey(source) {
  const namespace = sourceNamespace(source);
  return namespace.kind === 'host' ? 'host' : `container:${namespace.container_name}`;
}

function sourcesForNamespace(config, sourceTag) {
  if (sourceTag) {
    const selected = config.sources.find((source) => source.tag === sourceTag);
    if (!selected) throw new Error(`Unknown source tag: ${sourceTag}`);
    return config.sources.filter((source) => namespaceKey(source) === namespaceKey(selected));
  }
  const namespaces = new Set(config.sources.map(namespaceKey));
  if (namespaces.size > 1) throw new Error('A multi-namespace configuration requires an explicit source tag when rendering nftables');
  return config.sources;
}

function destinationNftSets(config, policy) {
  return policy.destination_sets.filter((name) => name !== 'default').flatMap((name) => {
    const destination = config.destination_sets[name];
    const result = [];
    if ((destination.ip_cidrs ?? []).length > 0) result.push(staticSetName(name));
    if ((destination.domain_suffixes ?? []).length > 0) result.push(dnsSetName(name));
    return result;
  });
}

function tunnelSelector(source, destinationSet) {
  return `iifname "${source.interface}" ip saddr @${sourceClientSetName(source)} ip daddr @${destinationSet}`;
}

export function generateNftablesConfig(input, { sourceTag } = {}) {
  const validation = validateConfig(input);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);
  const config = normalizeConfig(input);
  const sources = sourcesForNamespace(config, sourceTag);
  const sourceTags = new Set(sources.map((source) => source.tag));
  const strictPolicies = config.policies.filter((policy) => policy.failure_mode === 'block' &&
    policySources(policy, config).some((tag) => sourceTags.has(tag)));
  const destinationSets = strictPolicies.flatMap((policy) => policy.destination_sets)
    .filter((name) => name !== 'default')
    .filter((name, index, all) => all.indexOf(name) === index);

  const lines = [`table inet ${config.resources.nftables_table} {`];
  for (const source of sources.filter((candidate) => candidate.type === 'tunnel_interface')) {
    const scope = sourceClientScope(source);
    lines.push(`  set ${sourceClientSetName(source)} { type ipv4_addr; flags interval; elements = { ${scope.cidrs.join(', ')} } }`);
  }
  for (const name of destinationSets) {
    const cidrs = config.destination_sets[name].ip_cidrs ?? [];
    const suffixes = config.destination_sets[name].domain_suffixes ?? [];
    if (cidrs.length > 0) lines.push(`  set ${staticSetName(name)} { type ipv4_addr; flags interval; elements = { ${cidrs.join(', ')} } }`);
    if (suffixes.length > 0) lines.push(`  set ${dnsSetName(name)} { type ipv4_addr; flags interval; }`);
  }

  const tunnelSources = sources.filter((source) => source.type === 'tunnel_interface');
  const outputSources = sources.filter((source) => source.type === 'container_egress');
  if (tunnelSources.length > 0 && outputSources.length > 0) throw new Error('A container namespace cannot mix tunnel and container-egress source modes');

  if (tunnelSources.length > 0) {
    const selectors = [];
    for (const policy of strictPolicies) {
      for (const source of tunnelSources.filter((candidate) => policySources(policy, config).includes(candidate.tag))) {
        for (const nftSet of destinationNftSets(config, policy)) selectors.push({ source, selector: tunnelSelector(source, nftSet) });
      }
    }
    lines.push('  chain capture_redirect {');
    lines.push('    type nat hook prerouting priority dstnat; policy accept;');
    if (config.traffic_handling.dns_mode === 'managed') {
      for (const source of tunnelSources) {
        lines.push(`    iifname "${source.interface}" ip saddr @${sourceClientSetName(source)} udp dport 53 counter redirect to :5353`);
        lines.push(`    iifname "${source.interface}" ip saddr @${sourceClientSetName(source)} tcp dport 53 counter redirect to :5353`);
      }
    }
    for (const { selector } of selectors) lines.push(`    ${selector} meta l4proto tcp counter redirect to :${config.capture.listen_port}`);
    lines.push('  }');
    lines.push('  chain prerouting_guard {');
    lines.push('    type filter hook prerouting priority mangle; policy accept;');
    for (const { selector } of selectors) lines.push(`    ${selector} meta l4proto udp counter reject`);
    lines.push('  }');
    lines.push('  chain forward_guard {');
    lines.push('    type filter hook forward priority filter; policy accept;');
    for (const { selector } of selectors) lines.push(`    ${selector} meta l4proto tcp counter reject with tcp reset`);
    lines.push('  }');
  } else {
    const source = outputSources[0];
    const policies = strictPolicies.filter((policy) => policySources(policy, config).includes(source.tag));
    const nftSets = policies.flatMap((policy) => destinationNftSets(config, policy));
    lines.push('  chain capture_output {');
    lines.push('    type nat hook output priority dstnat; policy accept;');
    lines.push(`    meta mark ${CAPTURE_ROUTING_MARK} return`);
    lines.push(`    meta skuid ${MANAGED_DNS_UID} return`);
    if (config.traffic_handling.dns_mode === 'managed') {
      lines.push('    udp dport 53 counter redirect to :5353');
      lines.push('    tcp dport 53 counter redirect to :5353');
    }
    lines.push('    ip daddr 127.0.0.0/8 return');
    for (const nftSet of nftSets) lines.push(`    ip daddr @${nftSet} meta l4proto tcp counter redirect to :${config.capture.listen_port}`);
    lines.push('  }');
    lines.push('  chain output_guard {');
    lines.push('    type filter hook output priority filter; policy accept;');
    lines.push(`    meta mark ${CAPTURE_ROUTING_MARK} return`);
    lines.push(`    meta skuid ${MANAGED_DNS_UID} return`);
    lines.push('    meta nfproto ipv6 counter reject');
    for (const nftSet of nftSets) {
      lines.push(`    ip daddr @${nftSet} meta l4proto udp counter reject`);
      lines.push(`    ip daddr @${nftSet} meta l4proto tcp counter reject with tcp reset`);
    }
    lines.push('  }');
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}
