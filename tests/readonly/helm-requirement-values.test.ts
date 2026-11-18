// Pure protocol/projection values and synthetic-read reader only. No real adapters/CLI/spawn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmRequirementRequestSchema, helmRequirementResponseSchema, requirementText } from '../../src/shared/helm-requirement-protocol.ts';
import { createHelmRequirementReader } from '../../src/service/queries/helm-requirement-reader.ts';
import type { HelmRepositoryFileRead } from '../../src/service/queries/helm-repositories.ts';
const signal = () => new AbortController().signal;
const repositoriesYaml = 'apiVersion: v1\ngenerated: "0001-01-01T00:00:00Z"\nrepositories:\n- name: stable\n  url: https://charts.example.com/stable\n';
const indexYaml = 'apiVersion: v1\nentries:\n  nginx:\n  - name: nginx\n    version: 1.2.3\n    appVersion: 1.21.0\n    description: web server\n  - name: nginx\n    version: 1.1.0\n    appVersion: 1.20.0\n    description: web server\n  redis:\n  - name: redis\n    version: 0.9.0\n';
const readFile: HelmRepositoryFileRead = async (path, _maximumBytes) => path.endsWith('repositories.yaml') ? { content: repositoriesYaml, version: '1' } : path.endsWith('stable-index.yaml') ? { content: indexYaml, version: '1' } : null;
const defaults = () => ({ paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default' as const, indexDirectory: 'platform-default' as const } });
test('the request takes only bounded repository and chart names', () => {
  assert.equal(helmRequirementRequestSchema.safeParse({ protocol: 2, kind: 'read', repository: 'stable', chart: 'nginx' }).success, true);
  for (const bad of [{ repository: '' }, { repository: 'x y' }, { repository: 'x; rm -rf' }, { chart: '' }, { chart: 'a'.repeat(129) }, { repository: 'ok', kind: 'run' }, { repository: 'ok', extra: 1 }]) assert.equal(helmRequirementRequestSchema.safeParse({ protocol: 2, ...bad, ...(bad.chart === undefined ? { chart: 'nginx' } : {}) }).success === false, true, JSON.stringify(bad));
});
test('the text keeps the upstream Requirement shape with the @alias, never the URL', () => {
  assert.equal(requirementText('stable', 'nginx', '1.2.3'), '- name: nginx\n  version: 1.2.3\n  repository: @stable\n');
  assert.ok(!requirementText('stable', 'nginx', '1.2.3').includes('https://'));
  assert.equal(helmRequirementResponseSchema.safeParse({ protocol: 2, kind: 'helm-requirement', repository: 'stable', chart: 'nginx', version: '1.2.3', text: requirementText('stable', 'nginx', '1.2.3') }).success, true);
  assert.equal(helmRequirementResponseSchema.safeParse({ protocol: 2, kind: 'helm-requirement', repository: 'stable', chart: 'nginx', version: '1.2.3', text: 'x'.repeat(513) }).success, false);
  assert.equal(helmRequirementResponseSchema.safeParse({ protocol: 2, kind: 'helm-requirement-unavailable', code: 'NOT_FOUND' }).success, true);
});
test('a synthetic reader resolves the newest version exactly like upstream releases[0]', async () => {
  const reader = createHelmRequirementReader(readFile, defaults);
  const page = await reader.read({ protocol: 2, kind: 'read', repository: 'stable', chart: 'nginx' }, signal());
  assert.equal(page.kind, 'helm-requirement'); assert.equal(page.version, '1.2.3'); assert.equal(page.text, '- name: nginx\n  version: 1.2.3\n  repository: @stable\n');
  reader.close();
});
test('missing repository, chart or index map to fixed codes and never leak the URL', async () => {
  const reader = createHelmRequirementReader(readFile, defaults);
  await assert.rejects(reader.read({ protocol: 2, kind: 'read', repository: 'other', chart: 'nginx' }, signal()), /NOT_FOUND/);
  await assert.rejects(reader.read({ protocol: 2, kind: 'read', repository: 'stable', chart: 'ghost' }, signal()), /NOT_FOUND/);
  const noIndex: HelmRepositoryFileRead = async path => path.endsWith('repositories.yaml') ? { content: repositoriesYaml, version: '1' } : null;
  const missing = createHelmRequirementReader(noIndex, defaults);
  await assert.rejects(missing.read({ protocol: 2, kind: 'read', repository: 'stable', chart: 'nginx' }, signal()), /HELM_INDEX_MISSING/);
  reader.close(); missing.close();
});
test('invalid inputs and unfolded paths are rejected before any read', async () => {
  const reader = createHelmRequirementReader(readFile, defaults);
  await assert.rejects(reader.read({ protocol: 2, kind: 'read', repository: 'x; rm -rf', chart: 'nginx' }, signal()), /INVALID_INPUT/);
  const unfolded = createHelmRequirementReader(readFile, () => ({ paths: { repositoryFile: '/a/../b', indexDirectory: '/c' }, origins: { repositoryFile: 'platform-default' as const, indexDirectory: 'platform-default' as const } }));
  await assert.rejects(unfolded.read({ protocol: 2, kind: 'read', repository: 'stable', chart: 'nginx' }, signal()), /INVALID_INPUT/);
  reader.close(); unfolded.close();
});
