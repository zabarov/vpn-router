import { validateConfig } from './config-validator.mjs';

function setName(tag) {
  return `set_${tag.replaceAll('-', '_')}`;
}

export function generateDnsmasqConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);

  const strictDomainSets = new Set(
    config.policies
      .filter((policy) => policy.failure_mode === 'block')
      .flatMap((policy) => policy.destination_sets)
      .filter((name) => name !== 'default' && (config.destination_sets[name].domain_suffixes ?? []).length > 0)
  );
  const lines = ['port=5353', 'bind-interfaces'];
  for (const name of strictDomainSets) {
    const suffixes = config.destination_sets[name].domain_suffixes.map((suffix) => suffix.slice(1));
    lines.push(`nftset=/${suffixes.join('/')}/4#inet#${config.resources.nftables_table}#${setName(name)}`);
  }
  return `${lines.join('\n')}\n`;
}
