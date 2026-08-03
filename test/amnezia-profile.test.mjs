import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractAmneziaWg2Profile } from '../src/amnezia-profile.mjs';

function createTestTextKey(config) {
  const root = {
    containers: [{ awg: { last_config: JSON.stringify({ config }) } }]
  };
  const unpacked = Buffer.from(JSON.stringify(root));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(unpacked.length);
  return `vpn://${Buffer.concat([header, deflateSync(unpacked)]).toString('base64url')}`;
}

const nativeConfig = `[Interface]
PrivateKey = TEST_PRIVATE_KEY
Address = 10.8.1.2/32
Jc = 4
S3 = 64
S4 = 96
I1 = 101
I2 =

[Peer]
PublicKey = TEST_PUBLIC_KEY
AllowedIPs = 0.0.0.0/0
Endpoint = 192.0.2.1:51820
`;

test('extracts an embedded AWG2 profile without losing protocol fields', () => {
  const extracted = extractAmneziaWg2Profile(createTestTextKey(nativeConfig));
  assert.match(extracted, /^\[Interface\]$/m);
  assert.match(extracted, /^S3 = 64$/m);
  assert.match(extracted, /^S4 = 96$/m);
  assert.match(extracted, /^I1 = 101$/m);
  assert.doesNotMatch(extracted, /^I2\s*=/m);
  assert.match(extracted, /^\[Peer\]$/m);
});

test('rejects a non-Amnezia text key', () => {
  assert.throws(() => extractAmneziaWg2Profile('not-a-key'), /not an Amnezia/);
});

test('rejects a native profile without AWG2 S3 and S4 fields', () => {
  const wireGuardOnly = nativeConfig.replace(/^S[34].*\n/gm, '');
  assert.throws(() => extractAmneziaWg2Profile(createTestTextKey(wireGuardOnly)), /usable native AmneziaWG2/);
});

test('rejects wg-quick command hooks embedded in a text key', () => {
  const profileWithHook = nativeConfig.replace('Address = 10.8.1.2/32', 'Address = 10.8.1.2/32\nPostUp = touch /tmp/unsafe');
  assert.throws(() => extractAmneziaWg2Profile(createTestTextKey(profileWithHook)), /usable native AmneziaWG2/);
});
