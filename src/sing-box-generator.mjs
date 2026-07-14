import { validateConfig } from './config-validator.mjs';

function destinationCidrs(config, names) {
  return names.flatMap((name) => name === 'default' ? [] : config.destination_sets[name].ip_cidrs);
}

export function generateSingBoxConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);

  const endpoints = config.egresses
    .filter((egress) => egress.type === 'tailscale')
    .map((egress) => ({
      type: 'tailscale',
      tag: egress.tag,
      state_directory: egress.state_directory,
      hostname: config.resources.service_name,
      exit_node: egress.exit_node,
      system_interface: false
    }));

  const outbounds = [
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' }
  ];

  const routeRules = [];
  if (config.traffic_handling.udp_quic === 'reject') routeRules.push({ network: 'udp', outbound: 'block' });
  if (config.traffic_handling.ipv6 === 'reject') routeRules.push({ ip_is_private: false, ip_version: 6, outbound: 'block' });

  for (const policy of config.policies) {
    const cidrs = destinationCidrs(config, policy.destination_sets);
    if (cidrs.length === 0) {
      routeRules.push({ inbound: ['capture-in'], outbound: policy.failure_mode === 'block' ? 'block' : policy.egress });
      continue;
    }
    routeRules.push({ inbound: ['capture-in'], ip_cidr: cidrs, outbound: policy.egress });
  }

  return {
    log: { level: 'info', timestamp: true },
    inbounds: [{
      type: 'tproxy',
      tag: 'capture-in',
      listen: '0.0.0.0',
      listen_port: config.capture.listen_port,
      network: 'tcp'
    }],
    endpoints,
    outbounds,
    route: { rules: routeRules, final: 'direct' }
  };
}
