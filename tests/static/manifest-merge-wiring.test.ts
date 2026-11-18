// Source TEXT/metadata inspection only. No operation/adapter/worker/SDK/DOM imports or executions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('three-way sources are exact pinned public text at the already fixed apimachinery commit', async () => {
  const source = JSON.parse(await file('docs/baseline/manifest-merge-sources.json')) as { commit: string; records: { path: string; local: string; bytes: number; sha256: string }[] };
  assert.equal(source.commit, '7164e39885ced1e843757da6423a337f6eae75f7'); assert.equal(source.records.length, 4);
  assert.ok((await file('docs/baseline/query-sources.json')).includes(source.commit));
  for (const record of source.records) { const text = await file(record.local); assert.equal(Buffer.byteLength(text), record.bytes); assert.equal(createHash('sha256').update(text).digest('hex'), record.sha256); }
});
test('source contract separates three-way JSON null filters from strategic schema metadata and ordinary apply retries', async () => {
  const json = await file('tests/fixtures/contracts/manifest-apply-contract/pkg__util__jsonmergepatch__patch.go.txt'), strategic = await file('tests/fixtures/contracts/manifest-apply-contract/pkg__util__strategicpatch__patch.go.txt'), patcher = await file('tests/fixtures/contracts/manifest-write-contract/pkg__cmd__apply__patcher.go.txt');
  for (const part of ['jsonpatch.CreateMergePatch(current, modified)', 'jsonpatch.CreateMergePatch(original, modified)', 'keepOrDeleteNullInJsonPatch(addAndChangePatch, false)', 'keepOrDeleteNullInJsonPatch(deletePatch, true)', 'mergepatch.HasConflicts(']) assert.ok(json.includes(part), part);
  assert.ok(strategic.includes('CreateThreeWayMergePatch(') && strategic.includes('LookupPatchMeta'));
  assert.ok(patcher.includes('p.ResourceVersion != nil') && patcher.includes('types.StrategicMergePatchType') && patcher.includes('p.Retries'));
});
test('shared model is only bounded pure values and preserves exact decimals without enabling shared YAML or execution dependencies', async () => {
  const code = await file('src/shared/json-merge-comparison.ts');
  for (const part of ['200_000', 'depth > 64', '1_048_576', 'exponent.replace(/^[+-]/', 'new Map(', "model: 'three-way-json-merge'", 'filter(diff(live, desired, 0)', 'filter(diff(before, desired, 0)']) assert.ok(code.includes(part), part);
  assert.ok(!/from ['"].*(?:yaml|host\/|service\/|node:|sdk)|\.prepare\(|\.submit\(|fetch\(|serviceRequest|storage\.|console\./.test(code));
});
test('one portable value parser preserves the original Create semantics rather than diverging JSON/YAML numeric handling', async () => {
  const create = await file('src/parsing/manifest-create-source.ts'), parser = await file('src/parsing/manifest-values.ts');
  assert.ok(create.includes('for (const node of parseManifestValues(text, format, selection)) append(node, 0)'));
  for (const part of ['intAsBigInt: true', 'node.source', '20_000', 'depth > 32', 'values.length >= 32', 'strictNamespace: true', 'hasWellFormedUnicode(text)']) assert.ok(parser.includes(part), part);
  assert.ok(create.includes('inspectCreateObject(node)') && create.includes('readCreatePayload(result)'));
});
test('model review validates captured identity and original annotation but is not an Apply strategy selector or grant', async () => {
  const code = await file('src/parsing/manifest-merge-review.ts');
  for (const part of ["'kubectl.kubernetes.io/last-applied-configuration'", 'observed.uid', 'observed.resourceVersion', "origin === 'baseline' && key === 'resourceVersion'", '262_144', "kind: 'json-merge-model-only'", 'identity(original, \'baseline\')', 'set(annotations(normalized), annotation, undefined)']) assert.ok(code.includes(part), part);
  assert.ok(!/operations\/|serviceRequest|fetch\(|\.prepare\(|\.submit\(|openapi|writeFile|grant:/.test(code));
});
test('model inspection consumes only completed current Diff snapshots, retains at most one model and adds no RPC', async () => {
  const code = await file('src/host/manifest-diff-client.ts'), method = code.slice(code.indexOf('  inspectJsonMerge('), code.indexOf('  changed()'));
  for (const part of ["this.#phase !== 'ready'", 'this.#current(this.#source)', 'this.#clearMergeReviews()', 'reviewManifestJsonMerge(value.local, value.live', 'mergeReviewError', 'this.#paint(\'ready\')']) assert.ok(method.includes(part), part);
  assert.ok(!/#post\(|#request\(|\.read\(|\.prepare\(|\.submit\(/.test(method));
});
test('SDK diagnostic entry explicitly warns about strategic/Apply limitations and never introduces a submit button or body persistence', async () => {
  const view = await file('src/panel/manifest-diff-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.inspectManifestJsonMerge(selected)', 'No OpenAPI was read', 'strategic list semantics', 'execution-time version gates/single-dispatch writer remain unimplemented', 'pre.textContent = text', 'model.dispose()']) assert.ok(view.includes(part), part);
  assert.ok(bridge.includes('manifestDiff?.inspectJsonMerge(index)'));
  assert.ok(!/innerHTML|writeClipboard|storage\.|\.prepare\(|\.submit\(/.test(view));
});
test('automatic new model suites remain independent pure/read-only rather than real or mock operation lifecycle execution', async () => {
  const code = await file('tests/readonly/manifest-merge-review.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|bridge|sdk|node:fs)|\.prepare\(|\.submit\(|\.commit\(|\.handle\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/manifest-merge-review.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/manifest-merge-wiring.test.ts'"));
});
