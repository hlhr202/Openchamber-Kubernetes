// Text/metadata only. Never import or invoke real transports/adapters/SDK or any write chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves showInfoMessage is a pure information popup with no side actions', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), explorer = await file('tests/fixtures/baseline/kubernetes/src/helm.repoExplorer.ts.txt');
  assert.ok(extension.includes('async function showInfoMessage(message: string)') && extension.includes('await vscode.window.showInformationMessage(message);'));
  assert.ok(explorer.includes("command: 'extension.showInfoMessage'") && explorer.includes('Click for details'));
});
test('the controller activate surfaces only bounded message-node labels and clears on other selection', async () => {
  const code = await file('src/host/tree-controller.ts'), method = code.slice(code.indexOf('  // Upstream showInfoMessage'), code.indexOf('  stopWatchUpdates()'));
  for (const part of ["row.entry.node.type === 'message'", 'this.#message = row.entry.node.label', 'this.#message = null']) assert.ok(method.includes(part), part);
  assert.ok(method.includes('No Helm/refresh/install/write menu, no notification/chat/clipboard, no HTML'));
  assert.ok(!/serviceRequest|writeFile|\.submit\(|storage\.|console\./.test(method));
});
test('message labels stay schema-bounded text with no query, expansion or resource-write coupling', async () => {
  const entries = await file('src/shared/tree-entries.ts');
  assert.ok(entries.includes("z.object({ id, type: z.enum(['info', 'message']), label: boundedName, expandable: z.literal(false) }).strict()"));
  assert.ok(entries.includes('value.node.expandable === (value.query !== null)')); // message nodes can never carry a query
});
test('bridge exposes activation only and the panel renders bounded text without notifications or menus', async () => {
  const bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  assert.ok(bridge.includes('activateTreeMessage: (id: string) => tree.activate(id)') && bridge.includes('treeMessage: () => tree.snapshot.message'));
  assert.ok(main.includes("bridge?.treeMessage() ?? ''"));
  assert.ok(main.includes("messageStatus.setAttribute('role', 'status')"));
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(main));
});
test('automatic suites stay pure: the new readonly suite imports only the controller and synthetic gateways', async () => {
  const code = await file('tests/readonly/tree-message-node.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|sdk)|\.submit\(|\.execute\(|\.handle\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/tree-message-node.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/tree-message-node-wiring.test.ts'"));
});
