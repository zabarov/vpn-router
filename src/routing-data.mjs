import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { validateConfig } from './config-validator.mjs';
import { normalizeConfig } from './config-normalizer.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function durationToMs(value) {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(value ?? '');
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const factors = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * factors[match[2]];
}

function ipv4Number(address) {
  if (isIP(address) !== 4) throw new Error(`Not an IPv4 address: ${address}`);
  return address.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function numberIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function canonicalIpv4Cidr(value) {
  if (typeof value !== 'string') throw new Error('IPv4 prefix must be a string');
  const [address, prefixText, ...extra] = value.split('/');
  const prefix = Number(prefixText);
  if (extra.length || isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid IPv4 prefix: ${value}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const canonicalAddress = numberIpv4(ipv4Number(address) & mask);
  return `${canonicalAddress}/${prefix}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeIpv4Cidrs(values) {
  const entries = [...new Set(values.map(canonicalIpv4Cidr))].map((cidr) => {
    const [address, prefixText] = cidr.split('/');
    const prefix = Number(prefixText);
    const start = ipv4Number(address);
    const size = 2 ** (32 - prefix);
    return { cidr, start, end: start + size - 1, prefix };
  }).sort((left, right) => left.start - right.start || left.prefix - right.prefix);
  const result = [];
  let coveredEnd = -1;
  for (const entry of entries) {
    if (entry.end <= coveredEnd) continue;
    result.push(entry.cidr);
    coveredEnd = entry.end;
  }
  return result;
}

function requirements(config) {
  const countries = new Set();
  const domains = new Set();
  for (const destination of Object.values(config.destination_sets ?? {})) {
    for (const country of destination.country_codes ?? []) countries.add(country);
    for (const domain of destination.exact_domains ?? []) domains.add(domain);
  }
  return { countries: [...countries].sort(), domains: [...domains].sort() };
}

function entryFresh(entry, maxStaleMs, nowMs) {
  const retrieved = Date.parse(entry?.retrieved_at ?? '');
  return Number.isFinite(retrieved) && nowMs - retrieved <= maxStaleMs;
}

function refreshDue(entry, refreshMs, nowMs) {
  const retrieved = Date.parse(entry?.retrieved_at ?? '');
  return !Number.isFinite(retrieved) || nowMs - retrieved >= refreshMs;
}

function stateHash(state) {
  const copy = structuredClone(state);
  delete copy.sha256;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function routingConfigHash(config) {
  const routing = {
    routing_data: config.routing_data ?? null,
    destination_sets: Object.fromEntries(Object.entries(config.destination_sets ?? {}).map(([name, destination]) => [name, {
      country_codes: destination.country_codes ?? [],
      exact_domains: destination.exact_domains ?? [],
      ip_cidrs: destination.ip_cidrs ?? [],
      domain_suffixes: destination.domain_suffixes ?? []
    }]))
  };
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
}

async function fetchCountry(country, { fetchImpl, now, timeoutMs }) {
  const url = new URL('https://stat.ripe.net/data/country-resource-list/data.json');
  url.searchParams.set('resource', country.toLowerCase());
  url.searchParams.set('v4_format', 'prefix');
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`RIPEstat returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('RIPEstat response exceeds the size limit');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('RIPEstat response exceeds the size limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('RIPEstat response exceeds the size limit');
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('RIPEstat returned invalid JSON'); }
  const raw = payload?.data?.resources?.ipv4;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('RIPEstat returned an empty IPv4 resource list');
  const cidrs = normalizeIpv4Cidrs(raw);
  if (cidrs.length === 0) throw new Error('RIPEstat returned no usable IPv4 prefixes');
  return { cidrs, retrieved_at: now.toISOString(), source: url.origin, query_time: payload?.data?.query_time ?? null };
}

async function resolveDomain(domain, { resolve4, now, minTtl, maxTtl }) {
  const records = await resolve4(domain, { ttl: true });
  if (!Array.isArray(records) || records.length === 0) throw new Error('DNS returned no IPv4 addresses');
  const addresses = uniqueSorted(records.map((record) => typeof record === 'string' ? record : record.address));
  if (addresses.some((address) => isIP(address) !== 4)) throw new Error('DNS returned an invalid IPv4 address');
  const recordTtls = records.map((record) => typeof record === 'object' && Number.isFinite(record.ttl) ? record.ttl : minTtl);
  const ttl = Math.max(minTtl, Math.min(maxTtl, ...recordTtls));
  return { addresses, ttl, retrieved_at: now.toISOString(), expires_at: new Date(now.getTime() + ttl * 1000).toISOString() };
}

function retainPrevious(previous, key, maxStaleMs, nowMs, label, error) {
  const entry = previous?.[key];
  if (!entryFresh(entry, maxStaleMs, nowMs)) throw new Error(`${label} refresh failed and no fresh last-known-good entry exists: ${error.message}`);
  return { ...entry, retained_error: String(error.message).replace(/[\r\n\t]/g, ' ').slice(0, 240) };
}

function destinationData(config, countries, domains) {
  return Object.fromEntries(Object.entries(config.destination_sets ?? {}).map(([name, destination]) => [name, {
    country_cidrs: uniqueSorted((destination.country_codes ?? []).flatMap((country) => countries[country]?.cidrs ?? [])),
    exact_ips: uniqueSorted((destination.exact_domains ?? []).flatMap((domain) => domains[domain]?.addresses ?? []))
  }]));
}

export async function buildRoutingDataState(input, options = {}) {
  const validation = validateConfig(input);
  if (!validation.valid) throw new Error(`Cannot update routing data for an invalid configuration:\n- ${validation.errors.join('\n- ')}`);
  const config = normalizeConfig(input);
  const requested = requirements(config);
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolver = options.resolver ?? new Resolver();
  const resolve4 = options.resolve4 ?? resolver.resolve4.bind(resolver);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectedConfigHash = routingConfigHash(config);
  const previous = options.previous?.config_sha256 === expectedConfigHash ? options.previous : {};
  const countrySettings = config.routing_data?.country_provider;
  const domainSettings = config.routing_data?.domain_resolver;
  const countries = {};
  const domains = {};
  const warnings = [];

  for (const country of requested.countries) {
    if (!options.force && !refreshDue(previous.countries?.[country], durationToMs(countrySettings.refresh_interval), now.getTime())) {
      countries[country] = previous.countries[country];
      if (countries[country].retained_error) warnings.push(`country:${country}:last-known-good`);
      continue;
    }
    try {
      const next = await fetchCountry(country, { fetchImpl, now, timeoutMs });
      const oldCount = previous.countries?.[country]?.cidrs?.length ?? 0;
      if (oldCount >= 100 && next.cidrs.length < Math.floor(oldCount / 2)) throw new Error('RIPEstat prefix count shrank by more than 50 percent');
      countries[country] = next;
    } catch (error) {
      countries[country] = retainPrevious(previous.countries, country, durationToMs(countrySettings.max_stale), now.getTime(), `country ${country}`, error);
      warnings.push(`country:${country}:last-known-good`);
    }
  }

  for (const domain of requested.domains) {
    const expiresAt = Date.parse(previous.domains?.[domain]?.expires_at ?? '');
    const refreshMs = durationToMs(domainSettings.refresh_interval);
    if (!options.force && !refreshDue(previous.domains?.[domain], refreshMs, now.getTime()) && (!Number.isFinite(expiresAt) || expiresAt > now.getTime())) {
      domains[domain] = previous.domains[domain];
      if (domains[domain].retained_error) warnings.push(`domain:${domain}:last-known-good`);
      continue;
    }
    try {
      domains[domain] = await resolveDomain(domain, {
        resolve4,
        now,
        minTtl: domainSettings.min_ttl,
        maxTtl: domainSettings.max_ttl
      });
    } catch (error) {
      domains[domain] = retainPrevious(previous.domains, domain, durationToMs(domainSettings.max_stale), now.getTime(), `domain ${domain}`, error);
      warnings.push(`domain:${domain}:last-known-good`);
    }
  }

  const state = {
    schema_version: '1.0',
    config_sha256: expectedConfigHash,
    generated_at: now.toISOString(),
    status: warnings.length === 0 ? 'READY' : 'DEGRADED',
    warnings,
    countries,
    domains,
    destination_sets: destinationData(config, countries, domains)
  };
  state.sha256 = stateHash(state);
  return state;
}

export async function readRoutingDataState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state?.schema_version !== '1.0' || stateHash(state) !== state.sha256) throw new Error('routing data state integrity check failed');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRoutingDataState(path, state) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMode = (await stat(directory)).mode & 0o777;
  if ((directoryMode & 0o077) !== 0) throw new Error(`routing data directory must be private (0700 or stricter): ${directory}`);
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

export function defaultRoutingDataPath(config) {
  return `/var/lib/${normalizeConfig(config).resources.service_name}/data/state.json`;
}

export function routingDataRequirements(config) {
  return requirements(normalizeConfig(config));
}

export function assessRoutingDataState(input, state, now = new Date()) {
  const config = normalizeConfig(input);
  const requested = requirements(config);
  if (requested.countries.length + requested.domains.length === 0) return { status: 'READY', warnings: [] };
  if (!state) return { status: 'FAILED', warnings: ['state_missing'] };
  if (state.config_sha256 !== routingConfigHash(config)) return { status: 'FAILED', warnings: ['config_mismatch'] };
  const warnings = [...(state.warnings ?? [])];
  const nowMs = now.getTime();
  for (const country of requested.countries) {
    if (!entryFresh(state.countries?.[country], durationToMs(config.routing_data.country_provider.max_stale), nowMs)) {
      warnings.push(`country:${country}:stale`);
    }
  }
  for (const domain of requested.domains) {
    if (!entryFresh(state.domains?.[domain], durationToMs(config.routing_data.domain_resolver.max_stale), nowMs)) {
      warnings.push(`domain:${domain}:stale`);
    }
  }
  const failed = warnings.some((warning) => warning === 'state_missing' || warning.endsWith(':stale'));
  return { status: failed ? 'FAILED' : warnings.length > 0 ? 'DEGRADED' : 'READY', warnings };
}
