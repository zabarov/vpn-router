import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { generateUdpEgressNft } from '../src/udp-egress-generator.mjs';
import { buildRuntimePlan } from '../src/runtime-plan.mjs';

test('isolated UDP egress accepts only configured canary and ports towards tailscale0', async () => {
  const config = parse(await readFile(new URL('../examples/config.sip-udp.yaml', import.meta.url), 'utf8'));
  const plan = buildRuntimePlan(config);
  assert.deepEqual(plan.udp_routing.client_cidrs, ['10.42.0.2/32']);
  const generated = generateUdpEgressNft(config);
  assert.match(generated, /iifname "vrudp1" ip saddr @clients meta l4proto udp udp dport \{ 5060, 10000-50000 \} oifname "tailscale0" counter accept/);
  assert.match(generated, /iifname "vrudp1" counter reject/);
  assert.match(generated, /ip saddr @clients oifname "tailscale0" meta l4proto udp udp dport \{ 5060, 10000-50000 \} counter masquerade/);
  assert.doesNotMatch(generated, /flush ruleset|chain output/);
});
