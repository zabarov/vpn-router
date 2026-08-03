import { validateConfig } from './config-validator.mjs';

export function generateSingBoxConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);

  const strictPolicy = config.policies.find((policy) => policy.failure_mode === 'block');
  const outbounds = config.egresses.filter((egress) => egress.type === 'tailscale_socks').map((egress) => ({
      type: 'socks',
      tag: egress.tag,
      server: egress.proxy_server,
      server_port: egress.proxy_port,
      domain_resolver: { server: 'container-dns', strategy: 'ipv4_only' }
    }));

  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [{ type: 'local', tag: 'container-dns', prefer_go: true }],
      final: 'container-dns',
      strategy: 'ipv4_only',
      disable_cache: true
    },
    inbounds: [{
      type: 'redirect',
      tag: 'capture-in',
      listen: '0.0.0.0',
      listen_port: config.capture.listen_port
    }],
    outbounds,
    route: {
      rules: [{ inbound: ['capture-in'], outbound: strictPolicy.egress }],
      final: strictPolicy.egress
    }
  };
}
