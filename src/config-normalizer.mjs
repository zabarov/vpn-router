export function sourceClientScope(source) {
  const scope = source.clients ?? source.client_scope;
  if (scope?.mode === 'all') return { mode: 'all', cidrs: [] };
  if (scope?.mode === 'address_list') {
    return { mode: 'address_list', cidrs: [...scope.addresses] };
  }
  if (scope?.mode === 'subnet') {
    return { mode: 'subnet', cidrs: [scope.subnet] };
  }
  return { mode: 'address_list', cidrs: [source.client_subnet] };
}

export function sourceClientSetName(source) {
  return `source_${source.tag.replaceAll('-', '_')}_clients`;
}

export function sourceNamespace(source) {
  if (source.type === 'container_egress') return { kind: 'container', container_name: source.container_name };
  if (source.namespace === 'container') return { kind: 'container', container_name: source.container_name };
  return { kind: 'host' };
}

export function policySources(policy, config) {
  return policy.sources ?? config.sources.map((source) => source.tag);
}

export function normalizeConfig(config) {
  if (config?.schema_version !== '1.0') return structuredClone(config);

  const sources = config.sources.map((source) => {
    const clients = sourceClientScope(source);
    const normalizedClients = clients.mode === 'address_list'
      ? { mode: 'address_list', addresses: clients.cidrs }
      : { mode: 'subnet', subnet: clients.cidrs[0] };
    if (source.type === 'amneziawg2_container') {
      return {
        tag: source.tag,
        type: 'tunnel_interface',
        namespace: 'container',
        container_name: source.container_name,
        interface: source.interface,
        clients: normalizedClients
      };
    }
    return {
      tag: source.tag,
      type: 'tunnel_interface',
      namespace: 'host',
      interface: source.interface,
      clients: normalizedClients
    };
  });

  return {
    ...structuredClone(config),
    schema_version: '2.0',
    sources,
    policies: config.policies.map(({ source, ...policy }) => ({
      ...policy,
      sources: [source]
    }))
  };
}

export function migrateConfig(config) {
  if (config?.schema_version === '3.0') return structuredClone(config);
  if (!['1.0', '2.0'].includes(config?.schema_version)) throw new Error('only schema_version 1.0 or 2.0 can be migrated');
  return { ...normalizeConfig(config), schema_version: '3.0' };
}
