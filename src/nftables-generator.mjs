import { validateConfig } from './config-validator.mjs';

function setName(tag) {
  return `set_${tag.replaceAll('-', '_')}`;
}

function staticSetName(tag) {
  return `${setName(tag)}_static`;
}

function dnsSetName(tag) {
  return `${setName(tag)}_dns`;
}

function packetSelector(source, destinationSet) {
  return `iifname "${source.interface}" ip saddr ${source.client_subnet} ip daddr @${destinationSet}`;
}

export function generateNftablesConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);

  const strictPolicies = config.policies.filter((policy) => policy.failure_mode === 'block');
  const sets = strictPolicies.flatMap((policy) => policy.destination_sets)
    .filter((name) => name !== 'default')
    .filter((name, index, all) => all.indexOf(name) === index);

  const lines = [`table inet ${config.resources.nftables_table} {`];
  for (const name of sets) {
    const cidrs = config.destination_sets[name].ip_cidrs ?? [];
    const suffixes = config.destination_sets[name].domain_suffixes ?? [];
    if (cidrs.length > 0) lines.push(`  set ${staticSetName(name)} { type ipv4_addr; flags interval; elements = { ${cidrs.join(', ')} } }`);
    if (suffixes.length > 0) lines.push(`  set ${dnsSetName(name)} { type ipv4_addr; flags interval, timeout; timeout 10m; gc-interval 1m; }`);
  }

  const strictSelectors = [];
  for (const policy of strictPolicies) {
    const source = config.sources.find((candidate) => candidate.tag === policy.source);
    for (const destinationSet of policy.destination_sets.filter((name) => name !== 'default')) {
      const destination = config.destination_sets[destinationSet];
      const destinationSets = [];
      if ((destination.ip_cidrs ?? []).length > 0) destinationSets.push(staticSetName(destinationSet));
      if ((destination.domain_suffixes ?? []).length > 0) destinationSets.push(dnsSetName(destinationSet));
      for (const nftSet of destinationSets) {
        strictSelectors.push({ source, selector: packetSelector(source, nftSet) });
      }
    }
  }

  lines.push('  chain capture_redirect {');
  lines.push('    type nat hook prerouting priority dstnat; policy accept;');
  const hasStrictDomains = sets.some((name) => (config.destination_sets[name].domain_suffixes ?? []).length > 0);
  if (hasStrictDomains && config.traffic_handling.dns_mode === 'managed') {
    for (const policy of strictPolicies) {
      const source = config.sources.find((candidate) => candidate.tag === policy.source);
      lines.push(`    iifname "${source.interface}" ip saddr ${source.client_subnet} udp dport 53 counter redirect to :5353`);
      lines.push(`    iifname "${source.interface}" ip saddr ${source.client_subnet} tcp dport 53 counter redirect to :5353`);
    }
  }
  for (const { selector } of strictSelectors) {
    lines.push(`    ${selector} meta l4proto tcp counter redirect to :${config.capture.listen_port}`);
  }
  lines.push('  }');

  lines.push('  chain prerouting_guard {');
  lines.push('    type filter hook prerouting priority mangle; policy accept;');
  for (const { selector } of strictSelectors) {
    lines.push(`    ${selector} meta l4proto udp counter reject`);
  }
  for (const policy of strictPolicies) {
    const source = config.sources.find((candidate) => candidate.tag === policy.source);
    if (config.traffic_handling.udp_quic === 'reject') lines.push(`    iifname "${source.interface}" ip saddr ${source.client_subnet} udp dport 443 counter reject`);
  }
  lines.push('  }');

  // A selected TCP packet reaches this hook only if the NAT redirect did not
  // claim it. Rejecting here turns a missing/broken redirect into fail-closed
  // behavior while normal redirected traffic is delivered through INPUT.
  lines.push('  chain forward_guard {');
  lines.push('    type filter hook forward priority filter; policy accept;');
  for (const { selector } of strictSelectors) {
    lines.push(`    ${selector} meta l4proto tcp counter reject with tcp reset`);
  }
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
