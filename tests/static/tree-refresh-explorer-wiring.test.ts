// Text/metadata only. Never import or invoke real transports/adapters/SDK or any write chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream explorer text proves toolbar Refresh is a tree invalidation, not any data command', async () => {
  const explorer = await file('tests/fixtures/baseline/kubernetes/src/components/clusterexplorer/explorer.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  for (const part of ['refresh(node?: ClusterExplorerNode): void', 'this.onDidChangeTreeDataEmitter.fire(node)', 'queueRefresh(node?: ClusterExplorerNode)']) assert.ok(explorer.includes(part), part);
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesRefreshExplorer', () => treeProvider.refresh())"));
});
test('the controller refreshAll invalidates every query and re-reads only visible expanded branches', async () => {
  const code = await file('src/host/tree-controller.ts'), method = code.slice(code.indexOf('  // Upstream toolbar Refresh'), code.indexOf('  collapse('));
  for (const part of ['invalidateQueries(() => true)', "filter(row => row.expanded)", '#refreshes.retry(invalidated)', '#stop([...this.#pending.keys()])']) assert.ok(method.includes(part), part);
  assert.ok(method.includes('Never a Describe Refresh, Helm repo update, config switch, write, auth refresh, watch lifecycle or cross-context scan'));
  assert.ok(!/stopWatchUpdates|\.configure\(|serviceRequest|writeFile/.test(method));
});
test('the bridge exposes only the tree invalidation and the panel button is explicit', async () => {
  const bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  assert.ok(bridge.includes('refreshExplorer: () => tree.refreshAll()'));
  assert.ok(main.includes('bridge?.refreshExplorer()') && main.includes('Refresh Explorer (tree invalidation only, re-reads visible expanded)'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(main));
});
test('automatic suites stay pure: the new readonly suite imports only the controller and synthetic gateways', async () => {
  const code = await file('tests/readonly/tree-refresh-explorer.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|sdk)|\.submit\(|\.execute\(|\.handle\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/tree-refresh-explorer.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/tree-refresh-explorer-wiring.test.ts'"));
});
