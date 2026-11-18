// Source/public documentation TEXT only. Never import Save client/controller/adapter/bridge/runtime, even for rejected operations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('Save filesystem contract is exact Node24.22.1/POSIX9799919799 public text with independently checked hashes', async () => {
  const manifest = JSON.parse(await file('docs/baseline/save-sources.json')) as { node: string; posix: string; records: { name: string; bytes: number; sha256: string; url: string }[] };
  assert.equal(manifest.node, '24.22.1'); assert.equal(manifest.posix, '9799919799'); assert.equal(manifest.records.length, 2);
  for (const record of manifest.records) { const text = await file(`tests/fixtures/contracts/save-contract/${record.name}.txt`); assert.equal(Buffer.byteLength(text), record.bytes); assert.equal(createHash('sha256').update(text).digest('hex'), record.sha256); assert.ok(record.url.startsWith('https://')); }
  const posix = await file('tests/fixtures/contracts/save-contract/posix-link.html.txt'); assert.ok(posix.includes('atomically create a new hard link') && posix.includes('[EEXIST]') && posix.includes('If <i>link</i>() fails, no link shall be created'));
});
test('Save writer validates selected topology/owner and treats only final ENOENT as missing before exclusive 0600 staging', async () => {
  const text = await file('src/service/adapters/workspace-file-write.ts');
  for (const part of ['fileSaveTargetSchema.safeParse({ root, path })', 'values.length >= 128', '0o022n', '0o7000n', 'entry.nlink !== 1n', "codeOf(error) !== 'ENOENT'", 'constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600', 'stamp(before) !== stamp(after)', 'stamp(after) !== stamp(current)', 'await file.sync()', 'await directory.sync()']) assert.ok(text.includes(part), part);
  assert.ok(!/\b(?:mkdir|chown|exec|spawn|fetch)\(|from ['"].*(?:sdk|child_process|namespace-file)/.test(text));
});
test('new Save uses POSIX no-replace link; replacement verifies original version and same-plugin lock but never claims external CAS', async () => {
  const writer = await file('src/service/adapters/workspace-file-write.ts'), operations = await file('src/service/operations/file-save.ts');
  for (const part of ['await link(name, join(plan.root, plan.path))', "codeOf(error) === 'EEXIST'", "knownNoPublish = true; throw new BoundaryError('CONFLICT')", 'await rename(name, join(plan.root, plan.path))', 'next.version !== plan.version', 'NOT an external-process CAS', 'destination.ino !== owned.ino']) assert.ok(writer.includes(part), part);
  assert.ok(operations.includes('await options.lock.run(record.controller.signal') && (await file('src/service/runtime/main.ts')).includes('files: createWorkspaceFileWriter(), workspace, lock'));
});
test('Save cleanup unlinks only owned staging inode and never target or rollback; post-publication failures stay unknown', async () => {
  const text = await file('src/service/adapters/workspace-file-write.ts');
  for (const part of ['current.dev !== owned.dev', 'current.ino !== owned.ino', 'await unlink(temporary)', "cleanup = 'manual-check'", "'OPERATION_UNKNOWN'", 'Ignore cancellation after publication', 'new AbortController().signal']) assert.ok(text.includes(part));
  assert.ok(!/unlink\((?:join\(plan.root|absolute)|rollback\(|\.abort\(/.test(text));
});
test('Save ledger admits fixed sixty-second bounded payloads, never stores source tokens/body in public outcomes, and zeroes terminal payloads', async () => {
  const text = await file('src/service/operations/file-save.ts');
  for (const part of ['records.size + preparing >= 64', 'preparing >= 2', 'payloads + preparing >= 4', 'expiresAt = now + 60_000', 'record.payload?.fill(0)', 'delete record.source', '28_000', 'No eviction of unknown/manual-cleanup', 'record.requestId === request.requestId', 'previous.binding !== binding']) assert.ok(text.includes(part), part);
  const outcome = text.slice(text.indexOf('const outcome = Object.freeze<FileSaveOutcome>'), text.indexOf('const record: Record'));
  assert.ok(!/scope:|token:|capability:|text:|payload:/.test(outcome));
});
test('canonical upload is sequential/idempotent with exact chunk length, full SHA/fatal UTF-8/NUL finish and mandatory explicit submit', async () => {
  const text = await file('src/service/operations/file-save.ts'), protocol = await file('src/shared/file-save-protocol.ts');
  for (const part of ["chunk.toString('base64') !== request.data", 'chunk.length !== expected', 'request.offset % fileSaveChunkBytes !== 0', 'request.offset > record.outcome.received', 'timingSafeEqual(record.payload.subarray', 'digest(record.payload) !== record.outcome.digest', 'fatal: true, ignoreBOM: true', 'record.payload.includes(0)', "record.outcome.phase !== 'prepared'", "update(record, 'queued'); void execute(record)"]) assert.ok(text.includes(part), part);
  assert.ok(protocol.includes("confirmation: z.literal('save-exact-snapshot')"));
});
test('same-file proof sandwiches target inspect and uses only succeeded original receipts; scope is not write ownership', async () => {
  const text = await file('src/service/operations/file-save.ts');
  for (const part of ['options.workspace.read(', "value.phase !== 'succeeded'", 'value.versionAfter !== previous.version', 'page.version !== file.version', 'page.identity !== source.identity', 'const expected = await sourceProof', 'const second = await sourceProof', 'expected && plan.version !== expected', 'await verifySource(record); await options.files.verify', 'await verifySource(record);']) assert.ok(text.includes(part), part);
  assert.ok(!/projectId|hostAttested|SDK_WRITE|options\.config\.|\.refresh\(/.test(text));
});
test('Save HTTP route is original authenticated bounded JSON, separate from read scopes, and closes controller before reader', async () => {
  const text = await file('src/service/runtime/http.ts'), index = text.indexOf("url.pathname === '/v2/operations/file-save'");
  assert.ok(index > text.indexOf('authorized(request.headers.authorization'));
  const route = text.slice(index, text.indexOf("url.pathname === '/v2/helm/repositories/read'", index));
  assert.ok(route.includes('boundedBody(request, controller.signal, 48_000)') && route.includes('options.fileSaves.handle(input, controller.signal)'));
  assert.ok(text.includes('options.fileSaves.close(); options.workspace.close()'));
});
test('Save client freezes complete source, checks original buffer/revision before every block and submit, and never retries submit/status automatically', async () => {
  const text = await file('src/host/file-save-client.ts');
  for (const part of ['this.#calls >= 2', 'finally { this.#calls--; }', 'snapshot.owner !== record.owner', 'snapshot.source.revision !== record.outcome.source.revision', 'const chunk = saveContentChunk(bytes, offset)', "kind: 'finish'", "kind: 'submit'", "record.submitted = true", 'Never replay submit', 'bytes?.fill(0)', 'record.epoch !== this.#epoch', 'this.#history.set(record.outcome.id, record.outcome)']) assert.ok(text.includes(part), part);
  assert.ok(!/setInterval|setTimeout|storage\.|writeClipboard|\.files\.write|console\.|sendMessage/.test(text));
});
test('bridge/UI wire exact selected file Save/SaveAs, preserve Load origin, and acknowledge only exact successful snapshot', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/file-save-view.ts'), main = await file('src/panel/main.ts'), buffer = await file('src/shared/document-buffer.ts');
  for (const part of ['documentState.complete', 'workspaceState.stale', 'owner: file.origin', 'owner: editor.origin', 'previousFile: editor.savedFile', 'workspace.acknowledgeSaved', 'documents.acknowledgeSaved', 'fileSaves?.dispose()']) assert.ok(bridge.includes(part));
  for (const part of ['bridge()?.prepareFileSave(kind, root, path)', 'bridge()?.submitFileSave()', 'bridge()?.invalidateFileSave()', 'bridge()?.fileSaveStatus(row.id)', 'ACLs and extended attributes may not survive', 'Do not repeat an unknown save']) assert.ok(view.includes(part), part);
  assert.ok(main.includes('bridge.onFileSave(') && main.includes('stopFileSave(); fileSave.dispose()'));
  assert.ok(buffer.includes('this.#baseline = text; this.#savedFile = receipt') && buffer.includes('this.#revision !== revision'));
});
test('pure Save tests cannot transitively import a Save operation client/view/writer; boundaries and explicit allowlists include all new modules', async () => {
  const text = await file('tests/readonly/save-content.test.ts'), boundaries = await file('scripts/check-static.ts');
  assert.ok(!/from ['"].*(?:service\/|file-save-client|file-save-view|bridge|runtime\/|node:fs)|\.handle\(|\.submit\(|\.prepare\(|new FileSaveClient/.test(text));
  for (const part of ['workspace-file-write', 'file-save-client', 'file-save-view']) assert.ok(boundaries.includes(part));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/save-content.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/file-save-wiring.test.ts'"));
});
test('lost finish replies can regain exact unsubmitted confirmation by manual status, but attempted submissions never regain submit/cancel controls', async () => {
  const client = await file('src/host/file-save-client.ts'), view = await file('src/panel/file-save-view.ts');
  assert.ok(client.includes("!record.submitted && record.outcome.phase === 'prepared' && Date.now() < record.grant.expiresAt && this.#matches(record) ? 'confirm' : 'result'"));
  assert.ok(client.includes("kind: 'status', grant: record.grant })); this.#paint(this.#resultPhase())"));
  assert.ok(view.includes('busy || !!state.submitted || state.phase') && view.includes('busy || !!state.submitted || !outcome') && view.includes('Submission attempted; never resend'));
});
test('unknown or manual-cleanup original targets reject a new Save intent rather than silently re-inspecting and replaying', async () => {
  const code = await file('src/service/operations/file-save.ts');
  assert.ok(code.includes('fileSaveLocation(record.outcome.target) === fileSaveLocation(request.target)'));
  assert.ok(code.includes("record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check'"));
  assert.ok(code.includes("throw new BoundaryError('OPERATION_UNKNOWN')"));
});
test('original-file proof and successful receipt use canonical locations, so another root/path split cannot masquerade as Save As', async () => {
  const code = await file('src/service/operations/file-save.ts');
  assert.ok(code.includes('previous && fileSaveLocation(previous) === fileSaveLocation(target)'));
  assert.ok(code.includes('file && fileSaveLocation(file) === fileSaveLocation(target)'));
  assert.ok(code.includes('page.root !== file.root || page.path !== file.path || page.version !== file.version'));
});
test('the approved conflict loop closes: literal draft-vs-file comparison before Save As, never an overwrite', async () => {
  const view = await file('src/panel/file-save-view.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(view.includes('Compare draft vs current file (external modification)'));
  assert.ok(view.includes('Save As keeps both'));
  assert.ok(bridge.includes('compareFileConflict'));
  assert.ok(bridge.includes('compareDocumentText(file.text, current.text)'));
  assert.ok(bridge.includes('await workspace.captureFile(file.origin.path)'));
  assert.ok(!/innerHTML|writeClipboard/.test(view));
});
