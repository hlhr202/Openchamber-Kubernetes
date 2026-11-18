// Text/hash audit only; no source Go, runtime, file adapter or operation handler is executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('seven fixed SemVer contract texts have independent hashes and no runtime matrix claim', async () => {
  const index = JSON.parse(await file('docs/baseline/helm-semver-sources.json')) as { evidence: string; scope: string; records: Array<{ repo: string; tag: string; commit: string; path: string; bytes: number; sha256: string }> };
  assert.equal(index.evidence, 'M1-E052'); assert.equal(index.records.length, 7); assert.ok(index.scope.includes('not-cli-support'));
  for (const record of index.records) { const text = await file(`tests/fixtures/contracts/helm-semver-contract/${record.repo}/${record.path}.txt`); assert.equal(Buffer.byteLength(text), record.bytes); assert.equal(createHash('sha256').update(text).digest('hex'), record.sha256); assert.equal(record.commit, record.repo === 'helm/helm' ? '3d8990f0836691f0229297773f3524598f46bda6' : '61fc460d28283a91c53be65c2e0f20b494ac8ad9'); }
});
test('Helm pinned go.mod and NewVersion defaults substantiate coercion and unsigned 64-bit components', async () => {
  const mod = await file('tests/fixtures/contracts/helm-semver-contract/helm/helm/go.mod.txt'), version = await file('tests/fixtures/contracts/helm-semver-contract/Masterminds/semver/version.go.txt');
  assert.ok(mod.includes('github.com/Masterminds/semver/v3 v3.4.0') && version.includes('var CoerceNewVersion = true') && version.includes('return coerceNewVersion(v)') && version.includes('strconv.ParseUint(m[1], 10, 64)'));
});
test('search explicitly skips invalid versions and excludes prereleases under its fixed >0.0.0 constraint', async () => {
  const search = await file('tests/fixtures/contracts/helm-contract/cmd/helm/search_repo.go.txt'), constraints = await file('tests/fixtures/contracts/helm-semver-contract/Masterminds/semver/constraints.go.txt');
  assert.ok(search.includes('o.version = ">0.0.0"') && /semver.NewVersion\(r.Chart.Version\)\s*if err != nil \{\s*continue/.test(search)); assert.ok(constraints.includes('v.Prerelease() != "" && !includePre'));
});
test('pure bounded helper is consumed by projector, preserves originals and cannot run tools or execute arbitrary constraint code', async () => {
  const helper = await file('src/service/queries/helm-search-version.ts'), projector = await file('src/service/queries/helm-repository-source.ts');
  assert.ok(helper.includes('version.length > 256') && helper.includes('parsed[0] !== version') && helper.includes('18_446_744_073_709_551_615n'));
  assert.ok(!/\bimport\b|process\.|fetch\(|spawn\(|writeFile|eval\(|new Function/.test(helper)); assert.ok(projector.includes('helmSearchVersion(row.version)') && projector.includes('version: row.version') && projector.includes('compareHelmStableVersions(left.rank, right.rank)'));
});
test('schema/reader/UI disclose the new fixed source policy without claiming CLI runtime or a trusted cache origin', async () => {
  const protocol = await file('src/shared/helm-repository-protocol.ts'), reader = await file('src/service/queries/helm-repositories.ts'), ui = await file('src/panel/helm-repository-view.ts');
  for (const code of [protocol, reader]) assert.ok(code.includes('helm-v3.19.0-semver-v3.4.0-stable-gt-zero') && code.includes('filename-only-unverified-origin'));
  assert.ok(ui.includes('cached indexes') && ui.includes('phaseLabel(state.phase, zh)'));
});
test('SemVer suites are explicit allowlist entries, and synthetic functional tests do not import execution boundaries', async () => {
  const tests = await file('tests/readonly/helm-search-version.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts');
  assert.ok(readonly.includes("'tests/readonly/helm-search-version.test.ts'") && statics.includes("'tests/static/helm-semver-wiring.test.ts'"));
  assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(tests));
});
