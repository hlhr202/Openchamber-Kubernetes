// Text/metadata only: pin the upstream quickpick surface and Pod prompt;
// the Helm tree branches project through the same tree protocol and DOM renderer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the fixed upstream picker call sites and Pod prompt remain pinned', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  const sites = [...extension.matchAll(/showQuickPick/g)].length;
  assert.equal(sites, 11); // the audited fixed upstream picker surface
  const selectPodProtocol = await file('src/shared/select-pod-protocol.ts');
  assert.ok(selectPodProtocol.includes('Select a pod')); // the upstream-verbatim placeHolder in the pinned protocol
});
test('the Helm tree branches project through the tree protocol into the DOM renderer', async () => {
  const tree = await file('src/shared/tree.ts'), entries = await file('src/shared/tree-entries.ts'), view = await file('src/panel/tree-view.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(tree.includes("{ label: 'Helm Releases', dependency: 'helm' }")); // the tree contract keeps the Helm branch
  assert.ok(tree.includes("'helm-repo' | 'helm-deployed' | 'helm-failed'")); // dedicated Helm icons in the icon contract
  assert.ok(entries.includes("z.literal('helm-dependency')")); // helm branch queries ride the same tree read
  // The DOM renderer renders every controller row generically (role=treeitem), so Helm rows
  // render with the rest; the Helm repository/release clients drive their own views.
  assert.ok(view.includes("role', 'treeitem'"));
  assert.ok(bridge.includes('new HelmRepositoryClient') && bridge.includes('readHelmReleases'));
});
