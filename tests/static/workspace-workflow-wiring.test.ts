// Source and artifact TEXT only; no filesystem adapter/SDK/bridge/Save operation execution.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('comparison proof is encrypted under a distinct per-service audience and carries only hashes, never body or a mutable root/path', async () => {
  const code = await file('src/service/queries/workspace-reader.ts'), token = code.slice(code.indexOf('const proof = proofs.seal'), code.indexOf('const offset = previous'));
  assert.ok(code.includes("createSealedCursor('wsp1', 'openchamber-workspace-comparison-1')") && code.includes('proofs.dispose()'));
  for (const part of ['location: hash(JSON.stringify([scope.root, path]))', 'root: hash(scope.version)', 'snapshot: hash(value.version)', 'validUntil: now() + 86_400_000']) assert.ok(token.includes(part));
  assert.ok(!/text:|token:|capability:|scope:/.test(token));
});
test('explicit rebind compares original root/metadata/body identity, keeps fixed proof horizon, and issues a fresh scope through the original pool', async () => {
  const code = await file('src/service/queries/workspace-reader.ts'), body = code.slice(code.indexOf('async rebind('), code.indexOf('async list('));
  for (const part of ['proofSchema.safeParse(proofs.open(proof))', 'original.data.generation !== generation', 'original.data.location !== hash(JSON.stringify([root, path]))', 'hash(version) !== original.data.root', 'hash(value.version) !== original.data.snapshot', 'metadata.identity !== original.data.identity', 'now() >= original.data.validUntil', 'reads: 1', "'rebind', randomUUID()", 'proof, expiresAt']) assert.ok(body.includes(part), part);
  assert.ok(!/scope\.expiresAt\s*=|writeFile|operations\/|\.submit\(|\.handle\(/.test(body));
});
test('rebound original file retains identity lineage while cursors still bind new scope and other paths get independent identities', async () => {
  const code = await file('src/service/queries/workspace-reader.ts');
  assert.ok(code.includes('scope.lineage?.path === path ? scope.lineage.binding : binding'));
  assert.ok(code.includes('codec.seal({ binding, identity: metadata.identity') && code.includes('parsed.data.binding !== binding'));
});
test('directory adapter is real nonrecursive read-only opendir/lstat, blocks links/multiple links, and rechecks original topology/version', async () => {
  const code = await file('src/service/adapters/workspace-file-read.ts'), body = code.slice(code.indexOf('async listDirectory('));
  for (const part of ['opendir(absolute, { bufferSize: 32 })', 'for await (const entry of stream)', 'entries.length >= 2000', 'value.isSymbolicLink()', 'value.nlink === 1n', 'stamp(before) !== stamp(after)', '!== rootVersion', 'metadata.sort()']) assert.ok(body.includes(part), part);
  assert.ok(!/\b(?:writeFile|mkdir|rename|unlink|spawn|exec|fetch)\(|\.readFile\(/.test(body));
});
test('directory listing uses existing two slots and shared128 quota, with exact original listing identity and bounded100 pages', async () => {
  const code = await file('src/service/queries/workspace-reader.ts'), body = code.slice(code.indexOf('async list('), code.indexOf('release(input:'));
  for (const part of ['++scope.reads > 128', 'find(request.scope) !== scope', 'raw.entries.length > 2000', 'new Set(entries.map', 'request.listingIdentity !== listingIdentity', 'visible.slice(request.offset, request.offset + 100)', 'workspaceParent(request.path)']) assert.ok(body.includes(part), part);
  assert.ok(!/new ReadScheduler|setInterval|operations\/|\.commit\(|\.submit\(/.test(body));
});
test('client rebind never adopts disk body or rewrites dirty baseline/origin/revision, and late scopes are released', async () => {
  const code = await file('src/host/workspace-client.ts'), body = code.slice(code.indexOf('async rebind('), code.indexOf('async browse('));
  for (const part of ['file.origin.proof', 'page.identity !== file.origin.identity', 'page.version !== file.origin.version', 'page.proof !== file.origin.proof', 'this.#file !== file', 'this.#release(selected)', '{ ...file, readScope: selected.scope, detached: false }']) assert.ok(body.includes(part), part);
  assert.ok(!/this\.#baseline\s*=|dirty:\s*false|revision:\s*0|text:\s*page/.test(body));
});
test('root/long directory paths use bounded hashed scheduler keys without weakening generic scheduler admission', async () => {
  const code = await file('src/service/queries/workspace-reader.ts');
  assert.ok(code.includes("handle.id, 'file', hash(path)") && code.includes("request.scope.id, 'directory', hash(request.path)"));
  assert.ok((await file('src/service/queries/read-scheduler.ts')).includes('keyParts.some(part => !boundedName.safeParse(part).success)'));
});
test('explicit detached conflict drafts are barred from original canonical target before any previous receipt or source inspection', async () => {
  const code = await file('src/service/operations/file-save.ts'), bridge = await file('src/host/bridge.ts');
  const check = code.indexOf('file?.detached && fileSaveLocation(file) === fileSaveLocation(target)'); assert.ok(check > 0 && check < code.indexOf('const previous = source.previousFile'));
  assert.ok(bridge.includes('file.detached ? { detached: true }') && bridge.includes('fileSaves?.reset(); workspace.keepDraft()'));
});
test('file picker lists metadata only on explicit clicks, guards root drafts and dirty file replacement, and forwards only a directory hint to Save', async () => {
  const client = await file('src/host/workspace-client.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/workspace-view.ts'), save = await file('src/panel/file-save-view.ts');
  assert.ok(client.includes("entry.kind === 'directory' ? this.browse(path, page.showHidden) : this.read(path)"));
  for (const part of ['rootDraft === state.scope?.root', 'bridge()?.browseWorkspace(browseDraft, showHidden)', "entry.kind === 'blocked'", 'bridge()?.pickWorkspaceEntry(entry.name)', 'bridge()?.rebindWorkspace()']) assert.ok(view.includes(part));
  assert.ok(bridge.includes('scope: file.readScope ?? file.origin.scope') && bridge.includes('fileSaves?.reset(); return workspace.rebind()'));
  assert.ok(save.includes('bridge()?.workspaceDestinationDirectory()') && save.includes('directory.dispose()'));
  assert.ok(!/innerHTML|storage\.|writeClipboard|setInterval|setTimeout/.test(view + save));
});
test('read route and automatic dependency graph never enter Save operations; new suites are explicitly allowlisted', async () => {
  const runtime = await file('src/service/runtime/http.ts'), route = runtime.slice(runtime.indexOf("'/v2/workspace-files/open'"), runtime.indexOf("url.pathname === '/v2/operations/file-save'"));
  assert.ok(route.includes('options.workspace.rebind(input, controller.signal)') && route.includes('options.workspace.list(input, controller.signal)') && !route.includes('fileSaves.'));
  const testSource = await file('tests/readonly/workspace-workflow.test.ts'); assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|file-save-client|@openchamber)|\.submit\(|\.commit\(/.test(testSource));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/workspace-workflow.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/workspace-workflow-wiring.test.ts'"));
});
