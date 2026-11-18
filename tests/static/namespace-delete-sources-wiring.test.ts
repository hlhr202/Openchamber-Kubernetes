// TEXT ONLY. No deletion controller/client/planner/confirmation/hook/writer/worker invocation, even rejection/no-op/mock.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('Namespace deletion merge policy is separate from context deletion and prepares complete origin snapshots after auth/inventory checks', async () => {
  const schema = await file('src/shared/namespace-delete-protocol.ts'), client = await file('src/host/namespace-delete-client.ts'), op = await file('src/service/operations/namespace-delete.ts');
  assert.ok(schema.includes('selection: configSelectionSchema') && client.includes('selection: configSelectionSchema.parse(intent.selection)'));
  ordered(op.slice(op.indexOf("if (request.kind === 'prepare')")), 'bindResourceTarget(', 'privateKubectlConfiguration(config.merged, target).fill(0)', 'options.resources.namespaceInventory(', 'request.reference.name === target.namespace', "options.files.inspectNamespaceSources(request.selection, target, switching ? 'default' : target.namespace", 'bindResourceTarget(target, await options.config.read');
  assert.ok(!(await file('src/shared/context-delete-protocol.ts')).includes('namespaceDeleteOutcomeSchema'));
});
test('one lock checks sources before inventory, at stage hook and after config, never nested operation handlers or a second writer', async () => {
  const op = await file('src/service/operations/namespace-delete.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'await options.lock.run(', 'await verifySources()', 'options.resources.namespaceInventory(', 'if (record.switching)', 'await verifySources()', 'options.files.commit(', '() => options.files.verifyNamespaceSources(record.bundle, signal)', "result.phase !== 'succeeded'", 'versionAfter = result.versionAfter', 'await verifySources()', "namespace: 'default'", 'targetAfter: target');
  assert.equal(op.match(/options\.lock\.run\(/g)?.length, 1); assert.equal(adapter.match(/await rename\(/g)?.length, 1);
  assert.ok(!/createNamespaceOperations\(|createDeleteOperations\(|\.handle\(/.test(op));
});
test('post-commit verification accepts only actual writer metadata version plus intended content and retains every other source fact unchanged', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts'), op = await file('src/service/operations/namespace-delete.ts');
  const verify = adapter.slice(adapter.indexOf('async verifyNamespaceCommitted('), adapter.indexOf('async verifyContextSources('));
  ordered(verify, 'await snapshot(bundle.plan.path, signal, false)', 'value.version !== expectedVersion || hash(value.body) !== bundle.plan.intended', 'await contextSources(', 'source.path === bundle.plan.path ? { ...source, version: expectedVersion } : source', 'JSON.stringify(current.sources) !== JSON.stringify(expected)');
  assert.ok(op.includes('if (!result.versionAfter) throw new BoundaryError') && op.includes('options.files.verifyNamespaceCommitted(record.bundle, versionAfter, signal)'));
  assert.ok(!op.includes('options.files.verifyCommitted('));
});
test('non-current deletion skips all configuration writes and current default is unchanged without stage; cancellation/failed verification blocks later delete while preserving success', async () => {
  const op = await file('src/service/operations/namespace-delete.ts');
  ordered(op.slice(op.indexOf('if (record.switching)')), "plan.previous === plan.namespace ? { phase: 'succeeded'", "result: 'unchanged', versionAfter: plan.version", 'options.files.commit(');
  ordered(op.slice(op.indexOf("if (!['succeeded', 'skipped']")), 'options.resources.verifyReference(', 'await verifySources(); current(record)', 'options.execute(', 'current(record); clearTimeout(timer)');
  assert.ok(op.includes("switchDefault: ['checking', 'staging', 'committing'].includes") && op.includes(': record.outcome.switchDefault'));
  assert.ok(op.includes('!record.active &&') && !/retry\(|rollback\(|records\.clear\(/.test(op));
});
test('original sources survive result matching/history and confirmation discloses the unique origin and no-write branch without persistent content', async () => {
  const client = await file('src/host/namespace-delete-client.ts'), view = await file('src/panel/namespace-delete-view.ts'), op = await file('src/service/operations/namespace-delete.ts');
  assert.ok(client.includes('JSON.stringify(a.sources) === JSON.stringify(b.sources)') && client.includes('JSON.stringify([...new Set(selection.paths)])') && client.includes('++this.#historyRevision; this.#release'));
  assert.ok(view.includes('Deleting the current namespace first switches configuration to default') && view.includes('Failed inventory does not mean empty') && view.includes('value.sources.map('));
  assert.ok(op.includes('Buffer.byteLength(JSON.stringify(outcome)) > 24_000') && op.includes('sources: [...bundle.sources]'));
  assert.ok(!/setInterval|innerHTML|localStorage|clipboard|sendMessage/.test(client + view));
});
test('source policy DTO tests remain public-only and final source/physical/expiry checks stay ahead of the sole configuration rename', async () => {
  const read = await file('tests/readonly/namespace-delete-source-snapshot.test.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  assert.ok(!/from ['"].*(?:service\/|host\/|panel\/)/.test(read));
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'const current = await snapshot(', 'stage.ino !== owned.ino', 'beforeCommit(); attempted = true', 'await rename(');
  assert.ok(!(await file('src/service/operations/namespace-delete.ts')).includes('options.files.inspect(request.selection'));
});
