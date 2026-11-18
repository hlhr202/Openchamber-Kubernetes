// Text-only integration review, never imports bridge/SDK or real adapters/executors.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('validated Watch callback reaches existing diagnostic stale state and headless tree without modifying documents or write references', async () => {
  const bridge = await file('src/host/bridge.ts'), start = bridge.indexOf('const watches = new WatchClient'), end = bridge.indexOf('const branches =', start), callback = bridge.slice(start, end);
  assert.ok(callback.includes('resources.invalidate(state.page.source.resource, state.page.source.target)') && callback.includes('tree.observeWatch(state.page)') && callback.includes("state.phase === 'idle') tree.stopWatchUpdates()"));
  assert.ok(!/documents\.|inspections\.|deletes\.|submit|prepare|storage\./.test(callback));
});
test('tree invalidation is exact-target and conservatively refreshes Pod selector lists rather than fabricating metadata patches', async () => {
  const code = await file('src/shared/tree-watch.ts'); assert.ok(code.includes('sameTarget(query.target, source.target)') && code.includes("source.resource === 'pods'") && code.includes("query.kind === 'resources'"));
  assert.ok(!/resourceVersion\s*=|\.resourceVersion\s*=|storage\.|fetch\(|process\.|document\./.test(code));
});
test('coalescer uses non-sliding first-change window, two actual unsettled reads and 64 attempts', async () => {
  const code = await file('src/host/tree-refresh-queue.ts'); assert.ok(code.includes('setTimeout(callback, 250)') && code.includes('this.#running.size >= 2') && code.includes('this.#attempts >= 64'));
  const reset = code.slice(code.indexOf('reset(): void')); assert.ok(!reset.includes('this.#running.clear()')); assert.ok(code.includes("result.phase === 'error'") && code.includes('this.#blocked.add(id)'));
});
test('tree retains same full query identity expansion across RV but leaves old child content stale until validated re-read', async () => {
  const model = await file('src/shared/tree-model.ts'), controller = await file('src/host/tree-controller.ts');
  assert.ok(model.includes('sameTreeQueryIdentity(old.entry.query, entry.query)') && model.includes("phase: 'idle', stale: old.children.length > 0"));
  assert.ok(controller.includes("row.parent === id && row.expanded && (row.stale || row.phase === 'idle')") && controller.includes('this.#refreshes.add(result.children)'));
});
test('collapse/project/stop/dispose clear queued work and do not use operation/session cleanup', async () => {
  const code = await file('src/host/tree-controller.ts'); assert.ok(code.includes('this.#refreshes.remove(ids)') && code.includes('this.#refreshes.dispose()') && code.includes('controller.abort()') && code.includes('this.#automatic.get(id) === controller'));
  assert.ok(!/operations\/|sessions\/|localStorage|storage\.|console\.|spawn\(|writeFile|readThroughWorker/.test(code));
});
test('new suites are explicit allowlist members and only use synthetic projected reads', async () => {
  const code = await file('tests/readonly/tree-watch.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts');
  assert.ok(readonly.includes("'tests/readonly/tree-watch.test.ts'") && statics.includes("'tests/static/tree-watch-wiring.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(|runReadWorker\(/.test(code));
});
