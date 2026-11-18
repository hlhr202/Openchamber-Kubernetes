import { createTreeRenderer } from '../../../src/panel/tree-renderer.ts';
import { paintNamespaceSwitchStatus } from '../../../src/panel/namespace-switch-status.ts';
import { explorerNodeActions } from '../../../src/shared/explorer-actions.ts';
import { mountExecForwardDashboardView } from '../../../src/panel/exec-forward-dashboard-view.ts';
import { TreeModel } from '../../../src/shared/tree-model.ts';
import type { TreeSnapshot } from '../../../src/host/tree-controller.ts';
import type { SessionTargetState } from '../../../src/shared/session-target.ts';
import { captureScene, disposeScene, restoreScene, sceneRestoring } from '../../../src/panel/workspace-scene.ts';

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const target = { serviceGeneration: 'synthetic', projectId: 'project-a', configIdentity: 'config', context: 'synthetic', namespace: 'default' };

export async function checkExplorerAndForwardPresentation() {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = './panel.css';
  await new Promise<void>((resolve, reject) => { css.onload = () => resolve(); css.onerror = () => reject(new Error('Production CSS did not load')); document.head.append(css); });
  const host = document.createElement('main'); document.body.append(host);
  host.style.setProperty('--oc-focus', '#558bcb');
  const model = new TreeModel();
  model.reset([{ node: { id: 'pods', type: 'folder', label: 'Example Pods', expandable: true }, query: { kind: 'resources', resource: 'pods', target } },
    { node: { id: 'services', type: 'folder', label: 'Services', expandable: true }, query: { kind: 'resources', resource: 'services', target } }]);
  const [row, sibling] = model.visible(), id = row!.id;
  let opens = 0, pendingSelection: string | undefined;
  const renderer = createTreeRenderer(document, host, {
    onSelect: key => { pendingSelection = key; }, onExpand: () => { opens++; }, onCollapse() {}, onMore() {},
    onKeyboard: key => { model.keyboard(key); show(); }, onCommand() {},
  });
  function snapshot(rows = model.visible()): TreeSnapshot {
    return { generation: model.generation, rows, message: null, roots: { phase: 'ready', total: 2, nextOffset: null, error: null, available: true } };
  }
  function show() { renderer.render(snapshot()); }
  show();
  const renderedRow = () => host.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
  const initial = renderedRow(), label = initial.querySelector<HTMLElement>('.oc-k8s-tree-label')!;
  const other = host.querySelector<HTMLElement>(`[data-row-id="${sibling!.id}"]`)!;
  assert(initial.tabIndex === 0 && getComputedStyle(initial).outlineStyle === 'none', 'The default keyboard cursor drew an outline without focus');
  other.click(); show(); // A stale snapshot can arrive before the pointer command is acknowledged.
  assert(document.activeElement === other && getComputedStyle(initial).outlineStyle === 'none', 'Background snapshot pulled focus or drew the old outline');
  model.select(pendingSelection!); show();
  assert(other.tabIndex === 0 && other.getAttribute('aria-selected') === 'true', 'The click did not move the selected and keyboard rows together');
  other.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert(document.activeElement === initial && initial.matches(':focus-visible') && getComputedStyle(initial).outlineStyle === 'solid'
    && other.getAttribute('aria-selected') === 'true', `Keyboard focus mismatch: ${JSON.stringify({ active: document.activeElement === initial,
      visible: initial.matches(':focus-visible'), outline: getComputedStyle(initial).outlineStyle, selected: other.getAttribute('aria-selected') })}`);
  renderer.render(snapshot([...model.visible()].reverse()));
  assert(document.activeElement === initial && getComputedStyle(initial).outlineStyle === 'solid', 'Reordering rows dropped actual keyboard focus');
  show();
  const outside = document.createElement('button'); host.append(outside); outside.focus();
  assert(getComputedStyle(initial).outlineStyle === 'none', 'The tree kept an outline after focus left'); outside.remove();
  const computedSelection = getComputedStyle(label).userSelect;
  assert(computedSelection === 'none', 'Explorer text selection was not disabled');
  label.click(); model.select(pendingSelection!); show();
  assert(opens === 0 && label === initial.querySelector('.oc-k8s-tree-label'), 'Single-click expanded or replaced the double-click target');
  label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  assert(opens === 1, 'Double-click did not dispatch exactly one expansion');
  const start = () => { assert(model.expand(id, true), 'Expected a branch read'); const ticket = model.begin(id, false, true)!; show(); return ticket; };
  let ticket = start();
  const spinner = renderedRow().querySelector('.oc-k8s-tree-spinner')!;
  assert(spinner && getComputedStyle(spinner).animationName === 'oc-k8s-tree-spin', 'Busy indicator was not animated');
  assert(initial === renderedRow() && renderedRow().getAttribute('aria-expanded') === 'false' && renderedRow().getAttribute('aria-busy') === 'true', 'Branch opened prematurely');
  assert(!host.querySelector(`[data-row-id="${sibling!.id}"] .oc-k8s-tree-spinner`), 'An unrelated row spun');
  assert(model.fail(ticket, 'FORBIDDEN'), 'Failure settlement rejected'); show();
  assert(!renderedRow().querySelector('.oc-k8s-tree-spinner') && renderedRow().getAttribute('aria-expanded') === 'true' && renderedRow().textContent?.includes('FORBIDDEN'), 'Failed expansion did not settle visibly');
  model.collapse(id); model.invalidateQueries(() => true); ticket = start();
  assert(model.apply(ticket, { entries: [], cursor: null, proof: { resourceVersion: '5' } }), 'Successful settlement rejected'); show();
  assert(renderedRow().getAttribute('aria-expanded') === 'true' && !renderedRow().hasAttribute('aria-busy'), 'Success did not expand');
  renderer.dispose(); host.remove(); disposeScene(document);

  // Mount the real presentation without a bridge. There are no submit clicks,
  // transport stubs, sessions or cluster/authentication executors in the page.
  const state = (resource: 'services' | 'pods', name: string, forwardPorts: number[]): SessionTargetState => ({
    phase: 'ready', target, selection: { mode: 'default' }, containers: [], forwardPorts,
    reference: { type: { group: '', version: 'v1', kind: resource === 'services' ? 'Service' : 'Pod', resource, scope: 'namespace' }, namespace: 'default', name, uid: name, resourceVersion: '1' },
  });
  const service = state('services', 'web', [80, 443]), pod = state('pods', 'worker', [9090, 8080]);
  function mount() {
    const root = document.createElement('main'); document.body.append(root);
    const view = mountExecForwardDashboardView(document, root, () => undefined, () => 'en');
    view.selectTask('forward');
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Ports (local:remote)"]')!;
    return { view, root, input, dispose() { view.dispose(); root.remove(); disposeScene(document); } };
  }
  const first = mount(); sceneRestoring(document, false); first.view.showTarget(service);
  assert(first.input.value === '8080:80', 'Service used the wrong remote or filled all ports');
  first.root.querySelector<HTMLButtonElement>('[data-task="forward"] [aria-haspopup="listbox"]')!.click();
  const extra = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === '443');
  assert(extra, 'Second TCP port was not offered');
  extra!.click();
  assert(first.input.value === '8080:80, 8443:443', 'Adding a declared port replaced the first mapping');
  first.input.value = '5000:80'; first.input.dispatchEvent(new Event('input', { bubbles: true }));
  first.view.showTarget(pod); assert(first.input.value === '9090:9090', 'A Pod reused the Service draft');
  first.view.showTarget(state('pods', 'undeclared', [])); assert(first.input.value === '' && !first.input.disabled, 'No declarations did not allow manual input');
  first.view.showTarget(service); assert(first.input.value === '5000:80', 'Reselecting the Service overwrote the draft');
  first.input.focus(); first.input.setSelectionRange(0, 4, 'backward');
  const scene = captureScene(document, first.root); first.dispose();
  const second = mount(); second.view.showTarget(service); restoreScene(document, second.root, scene); sceneRestoring(document, false);
  assert(second.input.value === '5000:80' && second.input.selectionEnd === 4, 'Forward draft or caret was lost on recreation');
  second.dispose(); css.remove();
  const status = document.createElement('p'); status.setAttribute('role', 'status'); document.body.append(status);
  paintNamespaceSwitchStatus(status, { phase: 'switching', namespace: 'payments' }, false);
  assert(!status.hidden && !status.textContent?.includes('Saved'), 'Pending switch claims to have saved');
  paintNamespaceSwitchStatus(status, { phase: 'error', namespace: 'payments', error: 'OPERATION_UNKNOWN' }, false);
  assert(status.textContent?.includes('Could not confirm'), 'Unknown write is not visible');
  paintNamespaceSwitchStatus(status, { phase: 'error', namespace: 'payments', error: 'STATE_UNAVAILABLE', written: true }, false);
  assert(status.textContent?.includes('Saved payments, but could not verify the refresh'), 'Refresh failure was confused with write failure');
  paintNamespaceSwitchStatus(status, { phase: 'idle' }, false);
  assert(status.hidden, 'Status did not clear after scope refresh'); status.remove();
  const menu = explorerNodeActions({ node: { id: 'ns', type: 'resource', label: 'payments', expandable: false,
    resource: { group: '', kind: 'Namespace', version: 'v1', resource: 'namespaces', scope: 'cluster', name: 'payments', uid: 'ns', resourceVersion: '4' } },
  zh: false, configReady: true, stale: false, hasActiveContext: true, currentNamespace: 'default' });
  assert(menu.some(item => item.id === 'extension.vsKubernetesUseNamespace' && item.label === 'Use Namespace' && !item.disabled), 'Direct Namespace menu not available');
  return { selectionStyle: computedSelection, rowLocalSpinner: true, successAndFailureExpanded: true, serviceFirstOnly: '8080:80', podFirstOnly: '9090:9090', noDeclarationManual: true, draftRestored: true,
    namespaceMenuDirect: true, namespaceStatusDistinguishesUnknownWriteAndRefreshFailure: true,
    noResidualFocusOutline: true, keyboardFocusVisible: true };
}
