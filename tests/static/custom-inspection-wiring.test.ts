// Source TEXT only; never import SDK, adapters, CLI or operation/session handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('inspection has explicit pinned CRD admission without changing Delete/Explain/generic reference verification', async () => {
  const protocol = await file('src/shared/inspection-protocol.ts'), gateway = await file('src/service/queries/resource-gateway.ts'); assert.ok(protocol.includes('inspectionReferenceSchema = z.union([documentReferenceSchema, customDocumentReferenceSchema])'));
  for (const name of ['delete', 'explain']) assert.ok(!(await file(`src/shared/${name}-protocol.ts`)).includes('inspectionReferenceSchema'));
  assert.ok(gateway.includes('!documentReferenceSchema.safeParse(parsed.data.reference).success'));
});
test('custom inspection executes inside one existing finite slot without nested scheduler or new cache/operations', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), helper = await file('src/service/queries/custom-inspection.ts'); assert.ok(reader.includes("key(target, 'custom-inspection'") && reader.includes('readCustomInspection(readTarget(target)'));
  assert.ok(!/new ReadScheduler|\.run\(|writeFile|spawn\(|operations\/|sessions\//.test(helper));
});
test('custom printer orchestration brackets output with fresh definition/discovery and instance verification', async () => {
  const helper = await file('src/service/queries/custom-inspection.ts'); assert.ok(helper.includes('customDocumentProof(') && helper.includes('captureInspectionReference(') && helper.includes('verifyResourceObject('));
  assert.ok(helper.indexOf('const before = await proof()') < helper.indexOf("mode === 'wide' ? 'custom-wide'")); assert.ok(helper.indexOf('await proof() !== before') < helper.indexOf('return { text, reference: current }'));
  assert.ok(helper.includes('maximumReads = mode ? 7 : 5') && helper.includes('maximumBytes = mode ? 12_000_000 : 8_000_000'));
});
test('custom printer private worker validates exact path and strict reference independently of builtin purpose admission', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), worker = await file('src/service/queries/read-worker-protocol.ts'); assert.ok(plan.includes('planLoadDocument(request.customInspection, request.target)') && plan.includes('request.path !== plan.path'));
  assert.ok(worker.includes('customInspection: customDocumentReferenceSchema.optional()') && worker.includes('validateKubectlReadRequest(parsed.data.request)'));
  assert.ok(plan.includes("request.purpose !== 'custom-wide' && request.purpose !== 'custom-describe' && request.customInspection !== undefined"));
});
test('custom printers use the original cache sentinel verification before temporary HOME or any CLI', async () => {
  const worker = await file('src/service/adapters/read-worker.ts'); const at = worker.indexOf("start.request.purpose === 'custom-wide'"); assert.ok(at > 0 && at < worker.indexOf("await lstat('/dev/null'")); assert.ok(worker.indexOf("await lstat('/dev/null'") < worker.indexOf('home = await mkdtemp(')); assert.ok(worker.includes("start.request.purpose === 'custom-describe'"));
});
test('continuations select custom proof verifier and cannot replay printer; explicit refresh retains exact definition binding', async () => {
  const output = await file('src/service/queries/inspection-output.ts'), capture = await file('src/service/queries/inspection-reference.ts'); const continuation = output.slice(output.indexOf('if (cursor)'), output.indexOf('if (snapshots.size >= 16'));
  assert.ok(continuation.includes('reader.verifyCustomInspection(') && continuation.includes('reader.verifyReference(') && !continuation.includes('reader.inspect(')); assert.ok(capture.includes('inspectionReferenceSchema.safeParse') && capture.includes('Object.freeze(reference.data.definition)'));
});
test('CRD diagnostics have explicit Get/Describe entry and bounded plain output, never writes/Explain or terminal', async () => {
  const view = await file('src/panel/branch-diagnostics.ts'), output = await file('src/panel/inspection-view.ts'); assert.ok(view.includes("loadReference && 'definition' in loadReference") && view.includes('readInspection(loadReference, mode)'));
  assert.ok(output.includes('renderInspectionText(document, pre, logDisplayText(state.text))') && output.includes('Resource identifiers') && !/innerHTML|DocumentBuffer|\.submit\(|localStorage|clipboard|sendMessage/.test(output));
});
test('new synthetic custom inspection tests are explicit allowlist entries with no executor/real worker or write imports', async () => {
  const code = await file('tests/readonly/custom-inspection.test.ts'); assert.ok(!/from ['"].*(?:adapters\/|runtime\/|operations\/|sessions\/|bridge|@openchamber)|spawn\(|fork\(|runReadWorker\(|readThroughWorker\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/custom-inspection.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/custom-inspection-wiring.test.ts'"));
});
