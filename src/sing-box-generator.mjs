import { validateConfig } from './config-validator.mjs';

function destinationCidrs(config, names) {
  return names.flatMap((name) => name === 'default' ? [] : (config.destination_sets[name].ip_cidrs ?? []));
}

function destinationSuffixes(config, names) {
  return names.flatMap((name) => name === 'default' ? [] : (config.destination_sets[name].domain_suffixes ?? []));
}

export function generateSingBoxConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);

  const outbounds = [
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
    ...config.egresses.filter((egress) => egress.type === 'tailscale_socks').map((egress) => ({
      type: 'socks', tag: egress.tag, server: egress.proxy_server, server_port: egress.proxy_port
    }))
  ];

  const routeRules = [];
  const hasStrictPolicy = config.policies.some((policy) => policy.failure_mode === 'block');
  const hasStrictDomainPolicy = config.policies.some((policy) => policy.failure_mode === 'block' && destinationSuffixes(config, policy.destination_sets).length > 0);
  if (hasStrictDomainPolicy) routeRules.push({ inbound: ['capture-in'], action: 'sniff', timeout: '1s' });
  if (config.traffic_handling.udp_quic === 'reject') routeRules.push({ network: 'udp', outbound: 'block' });
  if (config.traffic_handling.ipv6 === 'reject') routeRules.push({ ip_is_private: false, ip_version: 6, outbound: 'block' });

  for (const policy of config.policies) {
    const cidrs = destinationCidrs(config, policy.destination_sets);
    const suffixes = destinationSuffixes(config, policy.destination_sets);
    if (cidrs.length === 0 && suffixes.length === 0) {
      continue;
    }
    if (cidrs.length > 0) routeRules.push({ inbound: ['capture-in'], ip_cidr: cidrs, outbound: policy.egress });
    if (suffixes.length > 0) routeRules.push({ inbound: ['capture-in'], domain_suffix: suffixes, outbound: policy.egress });
  }
  if (hasStrictPolicy) routeRules.push({ inbound: ['capture-in'], outbound: 'block' });

  return {
    log: { level: 'info', timestamp: true },
    inbounds: [{
      type: 'tproxy',
      tag: 'capture-in',
      listen: '0.0.0.0',
      listen_port: config.capture.listen_port,
      network: 'tcp'
    }],
    outbounds,
    route: { rules: routeRules, final: 'direct' }
  };
}
