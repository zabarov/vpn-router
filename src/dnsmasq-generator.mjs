import { validateConfig } from './config-validator.mjs';
import { normalizeConfig } from './config-normalizer.mjs';
import { MANAGED_DNS_UID } from './nftables-generator.mjs';

function setName(tag) {
  return `set_${tag.replaceAll('-', '_')}_dns`;
}

export function generateDnsmasqConfig(input) {
  const validation = validateConfig(input);
  if (!validation.valid) throw new Error(`Cannot generate an invalid configuration:\n- ${validation.errors.join('\n- ')}`);
  const config = normalizeConfig(input);

  const strictDomainSets = new Set(
    config.policies
      .filter((policy) => policy.failure_mode === 'block')
      .flatMap((policy) => policy.destination_sets)
      .filter((name) => name !== 'default' && (config.destination_sets[name].domain_suffixes ?? []).length > 0)
  );
  const lines = ['user=nobody', `# nftables-output-exclusion-uid=${MANAGED_DNS_UID}`, 'port=5353', 'bind-interfaces', 'max-ttl=300', 'max-cache-ttl=300'];
  for (const name of strictDomainSets) {
    const suffixes = config.destination_sets[name].domain_suffixes.map((suffix) => suffix.slice(1));
    lines.push(`nftset=/${suffixes.join('/')}/4#inet#${config.resources.nftables_table}#${setName(name)}`);
  }
  return `${lines.join('\n')}\n`;
}
