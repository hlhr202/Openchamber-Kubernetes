import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the development image uses the declared Node major and exact pnpm version in the offline amd64 check service', async () => {
  const root = JSON.parse(await file('package.json')) as { engines: { node: string }; packageManager: string };
  const dockerfile = await file('docker/dev.Dockerfile'), compose = await file('docker-compose.yml');
  assert.equal(root.engines.node, '24.x');
  assert.match(dockerfile, /node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.ok(dockerfile.includes(root.packageManager));
  assert.match(compose, /platform: linux\/amd64/);
  assert.match(compose, /^  dev:\n(?:    .*\n)*?    network_mode: none$/m);
});

test('the bundle targets are independent and only the Node service can externalize Node builtins', async () => {
  const compile = await file('scripts/compile.ts');
  assert.deepEqual([...compile.matchAll(/target: '([^']+)'/g)].map(match => match[1]), ['es2022', 'node24']);
  assert.ok(compile.includes("format: 'iife'") && compile.includes("format: 'esm'"));
  assert.match(compile, /external:.*node:/);
  assert.ok(compile.includes('THIRD_PARTY_NOTICES.txt'));
});
