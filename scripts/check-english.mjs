#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && existsSync(file));
const findings = [];

for (const file of files) {
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const lines = content.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/[\u0400-\u052f]/u.test(line)) findings.push(`${file}:${index + 1}`);
  });
}

if (findings.length > 0) {
  process.stderr.write(`english_check=FAIL\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('english_check=PASS\n');
}
