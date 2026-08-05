import { validateConfig } from './config-validator.mjs';
import { normalizeConfig, sourceNamespace } from './config-normalizer.mjs';
import { CAPTURE_ROUTING_MARK } from './nftables-generator.mjs';

export function generateSingBoxConfig(input, { sourceTag } = {}) {
  const validation = validateConfig(input);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);
  const config = normalizeConfig(input);

  const strictPolicy = config.policies.find((policy) => policy.failure_mode === 'block');
  const selectedSource = sourceTag ? config.sources.find((source) => source.tag === sourceTag) : undefined;
  if (sourceTag && !selectedSource) throw new Error(`Unknown source tag: ${sourceTag}`);
  const selectedNamespace = selectedSource ? sourceNamespace(selectedSource) : undefined;
  const namespaceCapturesOutput = !selectedSource || config.sources.some((source) => {
    if (source.type !== 'container_egress') return false;
    const namespace = sourceNamespace(source);
    return namespace.kind === selectedNamespace.kind && namespace.container_name === selectedNamespace.container_name;
  });
  const withCaptureMark = (outbound) => namespaceCapturesOutput
    ? { ...outbound, routing_mark: CAPTURE_ROUTING_MARK }
    : outbound;
  const outbounds = config.egresses.filter((egress) => egress.type !== 'direct').map((egress) => {
    if (egress.type === 'linux_interface') {
      return withCaptureMark({ type: 'direct', tag: egress.tag, bind_interface: egress.interface });
    }
    return withCaptureMark({
      type: 'socks',
      tag: egress.tag,
      server: egress.type === 'tailscale_socks'
        ? (selectedSource?.namespace === 'host' ? '127.0.0.1' : egress.proxy_server)
        : egress.server,
      server_port: egress.type === 'tailscale_socks' ? egress.proxy_port : egress.port,
      domain_resolver: { server: 'container-dns', strategy: 'ipv4_only' }
    });
  });

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
