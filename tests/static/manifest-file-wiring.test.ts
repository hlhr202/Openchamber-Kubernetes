// Text-only checks: never import/construct/call Save/Create clients, control planes, adapters, workers or hooks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('same portable pure parser validates browser and Server file payload without allowing a shared/host service dependency', async () => {
  const parser = await file('src/parsing/manifest-create-source.ts'), bundle = await file('src/parsing/manifest-bundle.ts'), check = await file('scripts/check-static.ts');
  assert.ok((await file('src/host/manifest-create-source.ts')).includes("export { encodeCreateSource } from '../parsing/manifest-create-source.ts'"));
  assert.ok(!/from ['"].*(?:host\/|service\/|sdk|node:)|fetch\(|writeFile|storage\.|serviceRequest/.test(parser + bundle));
  assert.ok(check.includes("path.startsWith('src/parsing/')") && check.includes('Nonportable parser dependency') && check.includes('(shared|parsing|panel|host|service\\/queries)'));
});
test('new Create write-client/view/adapter are explicitly forbidden in automatic read dependency graphs, including transitive edges', async () => {
  const code = await file('scripts/check-static.ts');
  assert.ok(code.includes('file-save-client|manifest-create-client') && code.includes('file-save-view|manifest-create-view') && code.includes('workspace-file-write|kubectl-manifest-create|manifest-create-worker'));
});
test('file source DTO keeps private comparison proof outside the public ledger and requires same exact location/version for receipt paths', async () => {
  const source = await file('src/shared/manifest-file-protocol.ts'), protocol = await file('src/shared/manifest-create-protocol.ts');
  assert.ok(source.includes('value.receipt.root === value.root && value.receipt.path === value.path && value.receipt.version === value.version'));
  assert.ok(protocol.includes('fileProof: workspaceProofSchema.optional()') && protocol.includes("value.kind === 'file-command'") && protocol.includes('value.source.file.receipt ? value.fileProof === undefined : value.fileProof !== undefined'));
  assert.ok(!/scope:|token:|content:|text:|fileProof:/.test(source));
});
test('full-file capture shares the existing read scope/scheduler/quota and has no new HTTP route or writer imports', async () => {
  const code = await file('src/service/queries/workspace-reader.ts'), capture = code.slice(code.indexOf('async capture('), code.indexOf('async open('));
  for (const part of ['parsed.data.cursor', 'scope.reads > 128', "[generation, handle.id, 'file', hash(path)]", 'backend.readFile(scope.root, scope.version, path, inner)', 'find(handle) !== scope', 'identity(scope.lineage?.path === path']) assert.ok(capture.includes(part), part);
  assert.ok(!/new ReadScheduler|operations\/|\.handle\(|writeFile|\.commit\(/.test(capture));
  assert.ok(!(await file('src/service/runtime/http.ts')).includes('options.workspace.capture('));
});
test('independent picked-file capture leaves editor/baseline/dirty state untouched while sharing the original two actual RPC slots', async () => {
  const code = await file('src/host/workspace-client.ts'), capture = code.slice(code.indexOf('async captureFile('), code.indexOf('async #capture('));
  assert.ok(capture.includes('this.#capture(scope, path, () =>') && capture.includes('this.#scope === scope && this.#directory === directory'));
  assert.ok(!/this\.#(?:file|baseline|revision|listing)\s*=|#paint\(|writeFile|\.submit\(/.test(capture)); assert.ok(code.includes('this.#calls >= 2') && code.includes('finally { this.#calls--; }'));
});
test('ordinary file pure source gate requires non-dirty/non-detached contents and never silently follows Save As to a different file', async () => {
  const code = await file('src/host/manifest-file-source.ts');
  for (const part of ["if (editor.dirty) throw new BoundaryError('DOCUMENT_DIRTY')", "if (editor.detached) throw new BoundaryError('CONFLICT')", 'receipt.root !== origin.root || receipt.path !== origin.path', 'fileProof: origin.proof']) assert.ok(code.includes(part), part);
  assert.ok(!/FileSaveClient|ManifestCreateClient|operations\/|\.prepare\(|\.submit\(|serviceRequest/.test(code));
});
test('only the original succeeded Save ledger plus current writer metadata/digest can authorize the saved-source receipt branch', async () => {
  const code = await file('src/service/operations/file-save.ts'), method = code.slice(code.indexOf('async verifyConsumption('), code.indexOf('async handle('));
  for (const part of ["record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check'", 'record.active || !terminal(record)', 'records.get(receipt.id)', 'receipt.generation !== options.generation', "outcome.phase !== 'succeeded'", "outcome.source.kind !== 'file'", 'outcome.source.identity !== input.identity', 'outcome.digest !== input.digest', 'actual.version !== receipt.version || actual.digest !== input.digest']) assert.ok(method.includes(part), part);
  assert.ok(!/\.commit\(|\.submit\(|\.handle\(|writeFile|new FileSaveClient/.test(method));
});
test('file Create uses a new private read scope from exact original proof or original succeeded receipt, without renewing the public scope/proof', async () => {
  const code = await file('src/service/operations/manifest-create.ts'), verify = code.slice(code.indexOf('async function verifyFile('), code.indexOf('async function proof('));
  for (const part of ['record.fileChecks > 100', 'options.fileSaves.verifyConsumption(', 'options.workspace.open(', 'options.workspace.rebind(', 'record.fileProof', 'options.workspace.capture(', 'actual.identity !== file.identity || actual.version !== file.version', 'actual.version !== record.fileBaseline.version', 'await guard(); current(record); return actual.text']) assert.ok(verify.includes(part), part);
  assert.ok(code.includes('options.workspace.release({ protocol: 2, scope: record.fileScope })'));
});
test('Server independently constructs full-file JSON and verifies original source SHA/canonical payload SHA/bytes before grant publication', async () => {
  const code = await file('src/service/operations/manifest-create.ts'), check = await file('src/parsing/manifest-file-check.ts');
  assert.ok(code.includes('verifiedManifestFilePayload(text, file.format, { sourceDigest: record.outcome.source.identity, payloadDigest: request.digest, payloadBytes: request.bytes })'));
  assert.ok(code.includes('record.payload = Buffer.from(canonical); record.outcome = freeze({ ...record.outcome, received: request.bytes })'));
  assert.ok(check.includes('source.digest !== expected.sourceDigest') && check.includes('payload.digest !== expected.payloadDigest || payload.bytes.length !== expected.payloadBytes'));
});
test('file metadata/content is checked at finish and after each exact target proof, including the final worker-ready gate', async () => {
  const code = await file('src/service/operations/manifest-create.ts'), proof = code.slice(code.indexOf('async function proof('), code.indexOf('function skipped('));
  assert.ok(proof.includes('await verifyFile(record); await bind(record); return reference'));
  assert.ok(code.slice(code.indexOf("request.kind === 'finish'"), code.indexOf("if (record.outcome.phase !== 'prepared' ||")).includes('await verifyFile(record)'));
  assert.ok(code.includes('await proof(record, item.index, reference); current(record); if (!workerLive())'));
});
test('Create File freezes original cluster context before independent capture and skips browser body upload only for Server-verified full-file intents', async () => {
  const code = await file('src/host/manifest-create-client.ts');
  for (const part of ['const { text, source, selection } = await capture()', 'epoch !== this.#epoch || !afterCapture', 'sameTarget(context.target, afterCapture.target)', 'JSON.stringify(context.selection) !== JSON.stringify(afterCapture.selection)', 'summary.file ? bytes.length : 0', 'let offset = response.outcome.received', 'sourceChanged() { if (!this.#independentFile) this.changed(); }']) assert.ok(code.includes(part), part);
});
test('ordinary dirty file Save is an explicit separate preparation, with no automatic confirmation/submit or Create continuation after ack', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/manifest-create-view.ts');
  const save = bridge.slice(bridge.indexOf('prepareFileSaveForCreate:'), bridge.indexOf('manifestCreateFileLocation:'));
  assert.ok(save.includes("fileSaves?.prepare('file', file.origin.root, file.origin.path)") && !/\.submit\(|\.prepareCaptured\(|\.acknowledgeSaved\(/.test(save));
  assert.ok(bridge.includes('manifestFileInput(await workspace.captureFile(path), format, true), format, true'));
  assert.ok(view.includes('bridge()?.prepareFileSaveForCreate()') && view.includes('bridge()?.prepareManifestCreateFile(path, format)') && view.includes('value.source.file.root'));
});
test('new automatic tests cannot import or call any real/mock Create/Save lifecycle; all new suites are explicitly allowlisted', async () => {
  const code = await file('tests/readonly/manifest-file-source.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|bridge|manifest-create-client|file-save-client|@openchamber|node:fs)|\.prepare\(|\.submit\(|verifyConsumption\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/manifest-file-source.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/manifest-file-wiring.test.ts'"));
});
