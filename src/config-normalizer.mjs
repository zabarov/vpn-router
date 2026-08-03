export function sourceClientScope(source) {
  if (source.client_scope?.mode === 'address_list') {
    return {
      mode: 'address_list',
      cidrs: [...source.client_scope.addresses]
    };
  }

  if (source.client_scope?.mode === 'subnet') {
    return {
      mode: 'subnet',
      cidrs: [source.client_scope.subnet]
    };
  }

  return {
    mode: 'address_list',
    cidrs: [source.client_subnet]
  };
}

export function sourceClientSetName(source) {
  return `source_${source.tag.replaceAll('-', '_')}_clients`;
}
