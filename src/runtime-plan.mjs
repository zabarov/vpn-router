import { normalizeConfig, sourceNamespace } from './config-normalizer.mjs';

function runtimeName(service, role, tag) {
  return [service, role, tag].filter(Boolean).join('-');
}

export function buildRuntimePlan(input) {
  const config = normalizeConfig(input);
  const strictPolicy = config.policies.find((policy) => policy.failure_mode === 'block');
  const strictEgress = config.egresses.find((egress) => egress.tag === strictPolicy.egress);
  const groupsByNamespace = new Map();
  for (const source of config.sources) {
    const namespace = sourceNamespace(source);
    const key = namespace.kind === 'host' ? 'host' : `container:${namespace.container_name}`;
    if (!groupsByNamespace.has(key)) {
      const tag = namespace.kind === 'host' ? 'host' : source.tag;
      groupsByNamespace.set(key, {
        tag,
        namespace: namespace.kind,
        container_name: namespace.container_name ?? null,
        source_tag: source.tag,
        source_tags: [],
        capture_name: runtimeName(config.resources.service_name, 'capture', tag),
        dns_name: runtimeName(config.resources.service_name, 'dns', tag)
      });
    }
    groupsByNamespace.get(key).source_tags.push(source.tag);
  }
  return {
    schema_version: '1.0',
    config_schema_version: config.schema_version,
    service_name: config.resources.service_name,
    nftables_table: config.resources.nftables_table,
    capture_port: config.capture.listen_port,
    managed_dns: strictPolicy.destination_sets.some((name) => (config.destination_sets[name]?.domain_suffixes ?? []).length > 0),
    strict_egress: strictEgress,
    egress_name: runtimeName(config.resources.service_name, 'egress'),
    control_network: runtimeName(config.resources.service_name, 'control'),
    proxy_network: runtimeName(config.resources.service_name, 'proxy'),
    groups: [...groupsByNamespace.values()]
  };
}
