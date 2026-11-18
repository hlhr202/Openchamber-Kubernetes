// Source text only. Never import real worker/CLI/SDK/operation/session handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('Explain custom admission requires explicit definition identity without changing Delete or generic builtin verification', async () => {
  const protocol = await file('src/shared/explain-protocol.ts'); assert.ok(protocol.includes('definition: definitionReferenceSchema.optional()') && protocol.includes('value.definition.name === `${value.type.resource}.${value.type.group}`') && protocol.includes('!builtinType(value.type)'));
  assert.ok(!(await file('src/shared/delete-protocol.ts')).includes('explainRequestSchema')); assert.ok((await file('src/service/queries/resource-gateway.ts')).includes('!documentReferenceSchema.safeParse(parsed.data.reference).success'));
});
test('local field helper checks loaded source/page/editor identity and projects only definition metadata with original fields', async () => {
  const code = await file('src/host/document-fields.ts'), projection = code.slice(code.indexOf('return explainRequestSchema.parse(')); assert.ok(code.includes('documentReferenceId(state.editor.origin.reference)') && code.includes('sameTarget(state.source.target, state.editor.origin.target)'));
  assert.ok(projection.includes('definition: state.source.reference.definition') && !/text:|body:|content:/.test(projection));
});
test('custom schema runner brackets index/schema/index with fresh CRD/discovery proofs inside existing scheduler', async () => {
  const helper = await file('src/service/queries/custom-explanation.ts'), reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(reader.includes('readCustomExplanation(input, sharedSignal, read, verify)') && reader.includes('definition: input.definition'));
  assert.ok(helper.includes('customDocumentProof(') && helper.includes('const original = await proof()') && helper.includes('await proof() !== original') && helper.includes('projectExplanation(schema, input)'));
  assert.ok(!/new ReadScheduler|\.run\(|new Map|operations\/|sessions\/|spawn\(|writeFile|fetch\(/.test(helper));
});
test('CRD schema runner enforces seven reads/16MB and preserves private 8MB schema versus 2MB other responses', async () => {
  const code = await file('src/service/queries/custom-explanation.ts'); assert.ok(code.includes('++reads > 7') && code.includes('bytes >= 16_000_000') && code.includes('16_000_000 - bytes'));
  assert.ok(code.includes("purpose === 'openapi-schema' ? openApiSchemaBytes : 2_000_000")); assert.ok(!code.includes("'custom-document'") && !code.includes("'custom-wide'") && !code.includes('preferredVersion'));
});
test('custom schema identity binds both pinned CRD proof and published locator without persisting schemas or sending proof', async () => {
  const code = await file('src/service/queries/custom-explanation.ts'); assert.ok(code.includes('JSON.stringify([original, before.identity])') && code.includes('return { explanation, schemaIdentity:'));
  assert.ok(!/setInterval|localStorage|storage\.|console\.|logger|clipboard|sendMessage/.test(code));
});
test('client compares definition identity and UI permits explicit original-GVK CRD field selection, not auto schema reads', async () => {
  const client = await file('src/host/explain-client.ts'), view = await file('src/panel/explain-view.ts'); assert.ok(client.includes('JSON.stringify(page.definition) !== JSON.stringify(source.definition)'));
  assert.ok(view.includes('loadDocumentReferenceSchema.safeParse(doc.source.reference)') && view.includes('published schema description') && view.includes('bridge()?.readExplanation(selected, doc.editor.revision)'));
  assert.ok(!/setInterval|innerHTML|\.prepare\(|\.submit\(|clipboard|sendMessage/.test(view));
});
test('custom proof helper accepts type/definition metadata without fabricating an instance resource UID or querying a body', async () => {
  const code = await file('src/service/queries/custom-explanation.ts'); assert.ok(code.includes('{ type, definition }') && code.includes('resourceObjectPath(crdType, definition.name)'));
  assert.ok(!/instance\.uid|resourceVersion:|namespace:|name: 'validation'|customDocument:/.test(code));
});
test('custom Explain synthetic and text suites are allowlisted and cannot import real I/O or write/session execution', async () => {
  const code = await file('tests/readonly/custom-explanation.test.ts'); assert.ok(!/from ['"].*(?:operations\/|sessions\/|adapters\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(|readThroughWorker\(|runReadWorker\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/custom-explanation.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/custom-explanation-wiring.test.ts'"));
});
