import { inflateSync } from 'node:zlib';

const MAX_PACKED_BYTES = 4 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

function decodePayload(textKey) {
  if (typeof textKey !== 'string') throw new Error('Amnezia text key must be UTF-8 text');
  const trimmed = textKey.trim();
  if (!trimmed.startsWith('vpn://')) throw new Error('input is not an Amnezia vpn:// text key');

  let encoded = trimmed.slice('vpn://'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Amnezia text key has an invalid URL-safe base64 payload');
  encoded = encoded.replaceAll('-', '+').replaceAll('_', '/');
  while (encoded.length % 4) encoded += '=';

  const packed = Buffer.from(encoded, 'base64');
  if (packed.length < 5 || packed.length > MAX_PACKED_BYTES) throw new Error('Amnezia text key has an invalid compressed payload size');
  const declaredLength = packed.readUInt32BE(0);
  if (declaredLength < 2 || declaredLength > MAX_UNPACKED_BYTES) throw new Error('Amnezia text key declares an unsafe uncompressed size');

  const unpacked = inflateSync(packed.subarray(4), { maxOutputLength: MAX_UNPACKED_BYTES });
  if (unpacked.length !== declaredLength) throw new Error('Amnezia text key length header does not match its payload');
  return JSON.parse(unpacked.toString('utf8'));
}

function embeddedConfigs(root) {
  if (!Array.isArray(root?.containers)) return [];
  return root.containers.flatMap((container) => {
    const lastConfig = container?.awg?.last_config;
    if (typeof lastConfig !== 'string') return [];
    try {
      const parsed = JSON.parse(lastConfig);
      return typeof parsed?.config === 'string' ? [parsed.config] : [];
    } catch {
      return [];
    }
  });
}

function normalizeAwg2Config(config) {
  if (/^\s*(?:PreUp|PostUp|PreDown|PostDown|SaveConfig)\s*=/mi.test(config)) {
    throw new Error('native profile contains unsupported command or persistence directives');
  }
  const normalized = config
    .split(/\r?\n/)
    .filter((line) => !/^\s*I[1-5]\s*=\s*$/.test(line))
    .join('\n')
    .trimEnd();

  const requiredMarkers = [
    /^\s*\[Interface\]\s*$/m,
    /^\s*\[Peer\]\s*$/m,
    /^\s*PrivateKey\s*=\s*\S+/m,
    /^\s*PublicKey\s*=\s*\S+/m,
    /^\s*S3\s*=\s*\S+/m,
    /^\s*S4\s*=\s*\S+/m
  ];
  if (requiredMarkers.some((pattern) => !pattern.test(normalized))) {
    throw new Error('the text key does not contain a complete native AmneziaWG2 profile');
  }
  return `${normalized}\n`;
}

export function extractAmneziaWg2Profile(textKey) {
  const root = decodePayload(textKey);
  for (const candidate of embeddedConfigs(root)) {
    try {
      return normalizeAwg2Config(candidate);
    } catch {
      // Continue only to another embedded AWG candidate. No candidate content
      // is included in the final error because it contains credentials.
    }
  }
  throw new Error('the text key does not contain a usable native AmneziaWG2 profile');
}
