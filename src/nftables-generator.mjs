import { validateConfig } from './config-validator.mjs';

function setName(tag) {
  return `set_${tag.replaceAll('-', '_')}`;
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
    const cidrs = config.destination_sets[name].ip_cidrs;
    const ipv4 = cidrs.filter((cidr) => !cidr.includes(':'));
    if (ipv4.length > 0) lines.push(`  set ${setName(name)} { type ipv4_addr; flags interval; elements = { ${ipv4.join(', ')} } }`);
  }

  lines.push('  chain prerouting {');
  lines.push('    type filter hook prerouting priority mangle; policy accept;');
  for (const policy of strictPolicies) {
    const source = config.sources.find((candidate) => candidate.tag === policy.source);
    for (const destinationSet of policy.destination_sets.filter((name) => name !== 'default')) {
      const ipv4 = config.destination_sets[destinationSet].ip_cidrs.filter((cidr) => !cidr.includes(':'));
      if (ipv4.length > 0) lines.push(`    iifname "${source.interface}" ip daddr @${setName(destinationSet)} meta l4proto tcp tproxy ip to :${config.capture.listen_port} meta mark set ${config.resources.routing_mark} accept`);
    }
    if (config.traffic_handling.udp_quic === 'reject') lines.push(`    iifname "${source.interface}" meta l4proto udp reject`);
    if (config.traffic_handling.ipv6 === 'reject') lines.push(`    iifname "${source.interface}" meta nfproto ipv6 reject`);
  }
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
