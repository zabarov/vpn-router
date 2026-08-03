#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { extractAmneziaWg2Profile } from '../src/amnezia-profile.mjs';

function usage() {
  return 'Usage: extract-amneziawg2-profile.mjs --input <profile.vpn> --output <profile.conf>';
}

async function main(argv) {
  const [inputOption, inputPath, outputOption, outputPath, ...extra] = argv;
  if (inputOption !== '--input' || !inputPath || outputOption !== '--output' || !outputPath || extra.length > 0) {
    throw new Error(usage());
  }

  try {
    await access(outputPath, constants.F_OK);
    throw new Error('output path already exists; refusing to overwrite it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const textKey = await readFile(inputPath, 'utf8');
  const nativeConfig = extractAmneziaWg2Profile(textKey);
  await writeFile(outputPath, nativeConfig, { mode: 0o600, flag: 'wx' });
  await chmod(outputPath, 0o600);
  process.stdout.write('profile_extraction=PASS\n');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`profile_extraction=FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
