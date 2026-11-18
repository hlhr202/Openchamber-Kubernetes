// TEXT ONLY. Do not import or run any planner/controller/client/confirmation/source hook/writer, including mock or no-op.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('fixed client-go deletes each named stanza only at its winning origin and does not recursively chase shadow definitions', async () => {
  const fixed = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/config.go.txt');
  for (const [loop, origin, removal] of [['for key, cluster := range startingConfig.Clusters', 'cluster.LocationOfOrigin', 'delete(configToWrite.Clusters, key)'], ['for key, context := range startingConfig.Contexts', 'context.LocationOfOrigin', 'delete(configToWrite.Contexts, key)'], ['for key, authInfo := range startingConfig.AuthInfos', 'authInfo.LocationOfOrigin', 'delete(configToWrite.AuthInfos, key)']]) {
    ordered(fixed.slice(fixed.indexOf(loop ?? '')), origin ?? '', 'configAccess.GetDefaultFilename()', removal ?? '', 'WriteToFile(');
  }
  const adapter = await file('src/service/adapters/namespace-file.ts'); assert.ok(adapter.includes('never chase a newly exposed shadow'));
});
test('all physical context definitions except the removed winning stanza protect shared references, including hidden same-name contexts', async () => {
  const planner = await file('src/service/operations/context-delete-document.ts');
  ordered(planner.slice(planner.indexOf('export function contextDeleteSourcesDescription(')), 'mergeConfigSources(inputs)', 'source.path === target.sourcePath && entry.name === context', 'others.filter(', 'sharedReferences', 'contextAfter');
  assert.ok(planner.includes('nextOrigin: paths[1] ?? null') && planner.includes('shadowDefinitions: Math.max(0, paths.length - 1)') && planner.includes("next.namespace || 'default'"));
});
test('source planner captures immutable per-step HMAC checkpoints across every source and only plans winning origin files that are writable', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts'), inspect = adapter.slice(adapter.indexOf('async inspectContextDeletionSources('), adapter.indexOf('async verifyContextDeletionSources('));
  ordered(inspect, 'contextSources(paths, context', 'contextDeleteSourcesDescription(inputs, context)', 'const checkpoints = [checkpoint()]', 'for (const entry of description.steps)', 'mergeConfigSources(inputs)', 'origin !== entry.path', 'await snapshot(value.path, signal)', 'deleteEntryDocument(input.content, section, entry.name, context, true)', 'previousBody: hash(input.content)', 'input.content = next; checkpoints.push(checkpoint())', 'after.contexts.has(context) !== description.contextRemains');
  assert.ok(!/writeFile\(|rename\(|spawn\(/.test(inspect) && inspect.includes('Object.freeze(checkpoints)'));
});
test('actual metadata versions are tracked per file, rebasing is bound to confirmed complete content and stage hooks use the current checkpoint', async () => {
  const op = await file('src/service/operations/context-delete.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'const versions = new Map(', 'options.lock.run(', 'JSON.stringify(fresh) !== JSON.stringify(record.bundle)', 'for (index = 0; index < 3; index++)', 'verifyContextDeletionSources(record.bundle, index, versions', 'versions.get(original.path)', 'rebaseEntry(original, expectedVersion', 'options.files.commit(', '() => options.files.verifyContextDeletionSources(record.bundle, index, versions', "result.phase !== 'succeeded'", 'versions.set(plan.path, result.versionAfter)', 'verifyContextDeletionSources(record.bundle, index + 1');
  assert.ok(!op.includes('lastVersion') && op.includes('verifyContextDeletionSources(record.bundle, 3, versions'));
});
test('checkpoint verification rejects changes to any source, missing slot or same-content metadata and the only rename still has final physical/expiry gates', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(adapter.slice(adapter.indexOf('async verifyContextDeletionSources(')), 'bundle.checkpoints[checkpointIndex]', 'await contextSources(', 'hash(value.body)', 'source.version !== (versions.get(source.path) ?? null)', 'content !== expected.find(');
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'const current = await snapshot(', 'stage.ino !== owned.ino', 'beforeCommit(); attempted = true', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1);
});
test('strict DTOs and explicit client/UI cover merge, origin/next-origin/shadow disclosures and newly exposed context without auth or automatic submission', async () => {
  const schema = await file('src/shared/context-delete-protocol.ts'), client = await file('src/host/context-delete-client.ts'), panel = await file('src/panel/main.ts'), view = await file('src/panel/context-delete-view.ts');
  assert.ok(schema.includes('selection: configSelectionSchema') && schema.includes('configurationSourceSchema.safeExtend(') && schema.includes('contextAfter: z.object('));
  assert.ok(client.includes('JSON.stringify(a.sources) === JSON.stringify(b.sources)') && client.includes('JSON.stringify(a.contextAfter) === JSON.stringify(b.contextAfter)') && client.includes('JSON.stringify([...new Set(selection.paths)])'));
  const button = panel.slice(panel.indexOf('const remove = mountButton(action,'), panel.indexOf('return row;', panel.indexOf('const remove = mountButton(action,')));
  assert.ok(!button.includes("sources.mode === 'merge'") && view.includes('same-name entry for another cluster') && view.includes('value.sources.map('));
  assert.ok(!/setInterval|localStorage|innerHTML|clipboard|sendMessage/.test(client + view));
});
test('failed or unknown checkpoints preserve successful steps, cancellation stops dependencies and no original metadata is overwritten for display', async () => {
  const op = await file('src/service/operations/context-delete.ts');
  assert.ok(op.includes("!['skipped', 'planned', 'succeeded'].includes(value.phase)") && op.includes('if (!committing) record.controller.abort()'));
  assert.ok(op.includes('!record.active &&') && op.includes('Buffer.byteLength(JSON.stringify(outcome)) > 28_000') && op.includes('sources: [...bundle.sources]'));
  assert.ok(!/sources:.*versions|retry\(|rollback\(|records\.clear\(/.test(op));
});
test('pure source DTO tests never import write modules; external-context planner flag stays private and false by default', async () => {
  const read = await file('tests/readonly/context-delete-source-snapshot.test.ts'), planner = await file('src/service/operations/context-delete-document.ts'), op = await file('src/service/operations/context-delete.ts');
  assert.ok(!/from ['"].*(?:service\/|host\/|panel\/)/.test(read));
  assert.ok(planner.includes('allowExternalContext = false') && planner.includes('!allowExternalContext && !config.contexts?.some'));
  assert.ok(!/privateKubectlConfiguration|bindResourceTarget|spawn\(|resources\./.test(op));
});
