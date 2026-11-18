// Text/metadata only: the tree menu/back/split, DAP control whitelist and session registry
// views are verified structurally; real keyboard/menu/drag behaviour belongs to human acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the tree view exposes an accessible action menu and resizable split without history navigation', async () => {
  const view = await file('src/panel/tree-view.ts'), css = await file('assets/panel/main.css'), main = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ["setAttribute('role', 'menu')", "role', 'menuitem'", 'contextmenu', "event.key === 'ContextMenu'", "event.key === 'F10' && event.shiftKey", 'aria-haspopup', 'openMenu']) assert.ok(view.includes(part), part);
  for (const part of ['oc-k8s-tree-nav', 'oc-k8s-tree-back', 'oc-k8s-tree-up', 'oc-k8s-tree-crumbs', 'history.push']) assert.ok(!view.includes(part), part);
  for (const part of ['oc-k8s-tree-split', '--oc-k8s-tree-split', 'setPointerCapture', 'Math.max(25, Math.min(80', 'col-resize']) assert.ok(view.includes(part) || css.includes(part), part);
  // The menu builder reuses ONLY the audited per-reference commands; no new surface.
  for (const part of ['documentReferenceFromNode(node)', 'readInspection(reference', 'readDocument(reference', 'prepareDelete({ reference', 'terminalSession.target(']) assert.ok(main.includes(part), part);
  assert.ok(bridge.includes('treeFocus: (id: string) => tree.focus(id)'));
  assert.ok(!/innerHTML|writeClipboard/.test(view + main));
});
test('the DAP control surface is a fixed whitelist with bounded breakpoint lines and poll-only reads', async () => {
  const operations = await file('src/service/operations/cluster-operations.ts'), client = await file('src/host/cluster-client.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ["z.literal('debug-send')", "z.enum(['continue', 'pause', 'next', 'stepIn', 'stepOut', 'stackTrace', 'scopes', 'variables', 'setBreakpoints', 'threads', 'disconnect'])", 'lines: z.array(z.number().int().min(1).max(100_000)).max(64)', 'value.command !== \'setBreakpoints\' || value.arguments !== undefined', 'entry.seq += 1', 'fixed command whitelist']) assert.ok(operations.includes(part), part);
  for (const part of ['debugSend', 'debugPoll', "kind: 'debug-send'", "kind: 'debug-poll'", 'messages: z.array(z.string().max(4_096)).max(16)']) assert.ok(client.includes(part), part);
  assert.ok(bridge.includes('debugSend') && bridge.includes('debugPoll'));
});
test('the session registry view is read-only with owner-gated stop and structured rows', async () => {
  const view = await file('src/panel/sessions-debug-view.ts'), bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  for (const part of ['mountSessionsView', 'mountDebugControlView', 'sessionClose()', 'Only sessions owned by this panel', 'configuration-results']) assert.ok(view.includes(part), part);
  assert.ok(bridge.includes('sessionsOverview') && bridge.includes("kind: 'list'"));
  assert.ok(main.includes('mountSessionsView') && main.includes('mountDebugControlView') && main.includes('sessionsOverview()'));
  assert.ok(!/innerHTML|writeClipboard|storage\./.test(view));
});
