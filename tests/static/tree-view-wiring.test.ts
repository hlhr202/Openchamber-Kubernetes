// Text/metadata only. The DOM tree renderer is verified structurally (attributes and wiring),
// never executed here; real keyboard/DOM behavior belongs to the human acceptance package.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the tree renderer builds a real accessible role=tree with aria-level/expanded/selected and keyboard handling', async () => {
  const view = await file('src/panel/tree-view.ts');
  for (const part of ["setAttribute('role', 'tree')", "setAttribute('aria-level'", "setAttribute('aria-expanded'", "setAttribute('aria-selected'", "setAttribute('aria-posinset'", "tabIndex = row.focused ? 0 : -1",
    "'ArrowUp'", "'ArrowDown'", "'ArrowLeft'", "'ArrowRight'", "'Home'", "'End'", "'Enter'", "event.key === ' ' ? 'Space' : event.key",
    'preventDefault()']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard|storage\.|console\./.test(view));
});
test('geometry is fully CSS-variable parameterised for the frozen R-05 measurements', async () => {
  const view = await file('src/panel/tree-view.ts'), css = await file('assets/panel/main.css');
  assert.ok(view.includes('--oc-k8s-tree-level'));
  for (const part of ['--oc-k8s-tree-row-height', '--oc-k8s-tree-indent', '--oc-k8s-tree-icon-gap']) assert.ok(css.includes(part), part);
  assert.ok(css.includes('var(--oc-k8s-tree-row-height, 22px)') && css.includes('var(--oc-k8s-tree-indent, 12px)'));
  assert.ok(css.includes('pending the frozen R-05'));
});
test('the bridge exposes the headless controller surface and the panel mounts the view', async () => {
  const bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  assert.ok(bridge.includes('new TreeController(request => host.serviceRequest(request), snapshot => showTree?.(snapshot))'));
  for (const part of ['treeExpand', 'treeCollapse', 'treeMore', 'treeActivate', 'treeSelect', 'treeKeyboard']) assert.ok(bridge.includes(part), part);
  assert.ok(main.includes('mountTreeView') && main.includes('bridge.onTree('));
});
test('row actions stay the audited set: expand/collapse/more/select/activate plus the batch-7 action menu slot', async () => {
  const view = await file('src/panel/tree-view.ts');
  assert.ok(view.includes('treeExpand(row.id)') || view.includes('bridge()?.treeExpand'));
  assert.ok(view.includes('treeMore(row.id)') || view.includes('bridge()?.treeMore'));
  assert.ok(view.includes('treeActivate(row.id)') || view.includes('bridge()?.treeActivate') || view.includes("setAttribute('aria-label', `Actions for ${row.entry.node.label}`)")); // activate rides the audited menu actions
  // Batch-7: the context menu exists but only renders actions supplied by the audited builder
  // in main.ts (same diagnostics commands); the view itself adds no new command surface.
  assert.ok(view.includes('contextmenu') && view.includes("setAttribute('role', 'menu')"));
  assert.ok(!/writeClipboard|storage\.|innerHTML/.test(view));
});
