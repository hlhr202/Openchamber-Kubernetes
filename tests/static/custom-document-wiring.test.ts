// Source text only: never import service runtime/SDK, file adapters or operation/session handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('Load request/response use explicit references; Delete/Explain retain builtin admission and inspection has a separate schema', async () => {
  const protocol = await file('src/shared/document-protocol.ts'); assert.ok(protocol.includes('reference: loadDocumentReferenceSchema') && protocol.includes('customDocumentReferenceSchema'));
  for (const path of ['delete-protocol', 'explain-protocol']) { const code = await file(`src/shared/${path}.ts`); assert.ok(code.includes('documentReferenceSchema') && !code.includes('loadDocumentReferenceSchema')); }
  assert.ok((await file('src/shared/inspection-protocol.ts')).includes('reference: inspectionReferenceSchema'));
});
test('custom Load plan pins CRD identity, exact served version and full discovery route, without shortName/version fallback', async () => {
  const plan = await file('src/service/queries/custom-document.ts'); assert.ok(plan.includes('version.name === type.version && version.served') && plan.includes('projectDiscovery(discoveryInput)') && plan.includes('definition.spec.names.plural !== type.resource'));
  assert.ok(!/shortNames\[|preferredVersion|spawn\(|writeFile|operations\/|sessions\//.test(plan));
});
test('document reader brackets lossless body with fresh proofs in one existing scheduler, enforcing five reads/eight MB', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), part = reader.slice(reader.indexOf('async document('), reader.indexOf('async events('));
  assert.ok(part.includes('planLoadDocument(reference, readTarget(target))') && part.includes('scheduler.run(') && part.includes('++reads > 5') && part.includes('8_000_000 - bytes'));
  assert.ok(part.indexOf('const before = await proof()') < part.indexOf('projectResourceDocument(text, plan.reference, format)') && part.indexOf('await proof() !== before') < part.indexOf('const page = project(document)'));
  assert.ok(!/reader\.definition\(|this\.definition\(|new ReadScheduler/.test(part));
});
test('continuation HMAC includes request reference and client comparison includes definition identity', async () => {
  const docs = await file('src/service/queries/documents.ts'), protocol = await file('src/shared/document-protocol.ts'), client = await file('src/host/document-client.ts');
  assert.ok(docs.includes('update(JSON.stringify(request))') && docs.includes('await reader.document(')); assert.ok(protocol.includes('ref.definition.uid, ref.definition.resourceVersion') && client.includes('documentReferenceId(page.reference) !== documentReferenceId(request.reference)'));
});
test('custom branch only adds explicit Load buttons, never enables Delete/inspection or reads during render', async () => {
  const view = await file('src/panel/branch-diagnostics.ts'); assert.ok(view.includes('customDocumentReferenceFromNode(node, state.page.definition)') && view.includes('readDocument(loadReference, format)') && view.includes('if (documentReference) rows.push(mountDeleteActions'));
  assert.ok(view.includes("state.phase !== 'ready' || state.stale || !enabled"));
});
test('CRD buffers freeze original definition and Explain independently validates the metadata-only original source', async () => {
  const buffer = await file('src/shared/document-buffer.ts'), fields = await file('src/host/document-fields.ts'), view = await file('src/panel/explain-view.ts');
  assert.ok(buffer.includes('definition: Object.freeze({ ...origin.reference.definition })') && fields.includes('documentReferenceId(state.editor.origin.reference)') && view.includes('published schema description'));
});
test('custom document suites are explicit allowlist entries and functional imports never reach writes/SDK/CLI workers', async () => {
  const code = await file('tests/readonly/custom-documents.test.ts'); assert.ok(!/from ['"].*(?:operations\/|sessions\/|adapters\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/custom-documents.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/custom-document-wiring.test.ts'"));
});
test('private worker independently validates pinned CRD Load paths without changing builtin object/printer admission', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), worker = await file('src/service/queries/read-worker-protocol.ts'), reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(plan.includes("request.purpose !== 'custom-document' && request.customDocument !== undefined") && plan.includes('request.path !== plan.path') && plan.includes('planLoadDocument(request.customDocument, request.target)'));
  assert.ok(worker.includes('customDocument: customDocumentReferenceSchema.optional()') && worker.includes('validateKubectlReadRequest(parsed.data.request)'));
  assert.ok(reader.includes("plan.custom ? 'custom-document' : 'resource-object'") && reader.includes('customDocument: plan.reference'));
});
