import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the SDK dependency and full source tree are pinned to the reviewed official host release', async () => {
  const root = JSON.parse(await file('package.json')) as { dependencies: Record<string, string> };
  const sources = JSON.parse(await file('docs/baseline/sources.json')) as { sources: { id: string; commit: string }[] };
  const tree = JSON.parse(await file('tests/fixtures/baseline/openchamber-tree.json')) as { sha: string; truncated: boolean };
  const host = JSON.parse(await file('tests/fixtures/baseline/openchamber/package.json.txt')) as { version: string };
  assert.equal(root.dependencies['@openchamber/sdk'], '2.5.1');
  assert.equal(host.version, '2.5.1');
  assert.equal(tree.sha, sources.sources.find(source => source.id === 'openchamber')?.commit);
  assert.equal(tree.truncated, false);
});
