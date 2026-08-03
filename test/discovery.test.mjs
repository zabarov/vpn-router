import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverAmneziaSources } from '../src/discovery.mjs';

test('discovery returns VPN topology and peer addresses without peer keys', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const key = args.join(' ');
    if (key === 'ps --format {{json .}}') {
      return '{"Names":"amnezia-awg","Image":"amneziavpn/amneziawg-go:3.0.3"}\n';
    }
    if (key === 'exec amnezia-awg ip -j -4 addr show') {
      return JSON.stringify([
        { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
        { ifname: 'eth0', addr_info: [{ family: 'inet', local: '172.18.0.2', prefixlen: 16, scope: 'global' }] },
        { ifname: 'awg0', addr_info: [{ family: 'inet', local: '10.8.1.1', prefixlen: 24, scope: 'global' }] }
      ]);
    }
    if (key === 'exec amnezia-awg awg show awg0 allowed-ips') {
      return 'peer-public-key-which-must-not-be-returned\t10.8.1.3/32,10.8.1.2/32\n';
    }
    throw new Error(`Unexpected call: ${key}`);
  };

  const candidates = await discoverAmneziaSources({ runner });
  assert.deepEqual(candidates, [{
    source_type: 'amneziawg2_container',
    container_name: 'amnezia-awg',
    container_image: 'amneziavpn/amneziawg-go:3.0.3',
    interface: 'awg0',
    interface_address: '10.8.1.1/24',
    client_subnet: '10.8.1.0/24',
    client_addresses: ['10.8.1.2/32', '10.8.1.3/32']
  }]);
  assert.doesNotMatch(JSON.stringify(candidates), /peer-public-key/);
  assert.ok(calls.some((call) => call.includes('allowed-ips')));
});

test('discovery falls back to wg and ignores containers without a readable VPN interface', async () => {
  const runner = async (command, args) => {
    const key = args.join(' ');
    if (key === 'ps --format {{json .}}') {
      return '{"Names":"generic-vpn","Image":"example/vpn"}\n{"Names":"unreadable","Image":"example/other"}\n';
    }
    if (key === 'exec generic-vpn ip -j -4 addr show') {
      return JSON.stringify([{ ifname: 'wg-in', addr_info: [{ family: 'inet', local: '100.64.10.1', prefixlen: 24, scope: 'global' }] }]);
    }
    if (key === 'exec generic-vpn awg show wg-in allowed-ips') throw new Error('awg is unavailable');
    if (key === 'exec generic-vpn wg show wg-in allowed-ips') return 'key\t100.64.10.2/32\n';
    if (key === 'exec unreadable ip -j -4 addr show') throw new Error('ip is unavailable');
    throw new Error(`Unexpected call: ${key}`);
  };

  const candidates = await discoverAmneziaSources({ runner });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].interface, 'wg-in');
  assert.deepEqual(candidates[0].client_addresses, ['100.64.10.2/32']);
});
