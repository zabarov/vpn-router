import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { validateConfig } from '../src/config-validator.mjs';

async function loadSchemaAndExample() {
  const [schemaText, exampleText] = await Promise.all([
    readFile(new URL('../schema/config.schema.json', import.meta.url), 'utf8'),
    readFile(new URL('../config.example.yaml', import.meta.url), 'utf8')
  ]);
  return { schema: JSON.parse(schemaText), example: parse(exampleText) };
}

test('the public example satisfies the published JSON Schema', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test('the published JSON Schema accepts an explicit VPN client subnet', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  example.sources[0].clients = { mode: 'subnet', subnet: '10.20.0.0/24' };
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test('the published JSON Schema rejects an implicit all-addresses scope', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  example.sources[0].clients = { mode: 'subnet', subnet: '0.0.0.0/0', unexpected: true };
  assert.equal(validate(example), false);
});

test('the published JSON Schema rejects Tailscale-only fields on direct egress', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const direct = example.egresses.find((egress) => egress.type === 'direct');
  direct.exit_node = 'unexpected.example.ts.net';
  assert.equal(validate(example), false);
  assert.ok(validate.errors.some((error) => error.instancePath.includes('/egresses/')));
});

test('provider-neutral deployment examples satisfy schema and semantic validation', async () => {
  const { schema } = await loadSchemaAndExample();
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const relativePath of ['../examples/config.socks5.yaml', '../examples/config.linux-interface.yaml', '../lab/redirect/config.subnet.yaml']) {
    const example = parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
    assert.equal(validateSchema(example), true, `${relativePath}: ${JSON.stringify(validateSchema.errors)}`);
    assert.deepEqual(validateConfig(example), { valid: true, errors: [] }, relativePath);
  }
});
