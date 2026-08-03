import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

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

test('the published JSON Schema rejects a client pool for the canary MVP', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  example.sources[0].client_subnet = '10.8.1.0/24';
  assert.equal(validate(example), false);
  assert.ok(validate.errors.some((error) => error.instancePath.endsWith('/client_subnet')));
});

test('the published JSON Schema rejects Tailscale-only fields on direct egress', async () => {
  const { schema, example } = await loadSchemaAndExample();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const direct = example.egresses.find((egress) => egress.type === 'direct');
  direct.exit_node = 'unexpected.example.ts.net';
  assert.equal(validate(example), false);
  assert.ok(validate.errors.some((error) => error.instancePath.includes('/egresses/')));
});
