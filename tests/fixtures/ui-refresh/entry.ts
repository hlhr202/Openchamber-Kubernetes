// Pure presentation in real container Chromium. No host SDK connection, product
// runtime, authentication, session, PTY, input executor or mock operating chain.
import { mountTextField, mountSelect } from '../../../src/panel/controls.ts';
import { bindScene, captureScene, restoreScene, sceneRestoring, disposeScene, sceneChanged } from '../../../src/panel/workspace-scene.ts';
import { mountSceneCheckpoints } from '../../../src/panel/scene-checkpoints.ts';
import { visiblePresentation, setText } from '../../../src/panel/presentation-update.ts';
import { checkExplorerAndForwardPresentation } from './explorer-and-forward.ts';
import { checkWorkbenchAndIcons } from './workbench-and-icons.ts';

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function check() {
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; return Promise.reject(new Error('Network forbidden')); };
  const checks: Record<string, unknown> = {}, start = performance.now();
  function mount() {
    const root = document.createElement('main'), controls = document.createElement('div'), viewport = document.createElement('div'), renderer = document.createElement('div');
    viewport.style.cssText = 'height:100px;width:300px;overflow:auto';
    renderer.setAttribute('data-scene-renderer', '');
    root.append(controls, viewport, renderer); document.body.append(root);
    let draft = 'initial', reads = 0;
    const field = mountTextField(controls, { label: 'Draft', value: draft, onChange(value) { draft = value; } });
    const select = mountSelect(controls, { label: 'Container', value: 'app', options: [{ id: 'app', label: 'App' }], onChange() {} });
    const details = document.createElement('details'), nested = document.createElement('details');
    const long = document.createElement('p'); long.style.height = '1200px'; long.textContent = 'Synthetic content'; nested.append(long); details.append(nested); viewport.append(details);
    const rows = document.createElement('div');
    rows.append(...Array.from({ length: 5000 }, (_, index) => {
      const row = document.createElement('div'); row.textContent = `synthetic-resource-${index}`; return row;
    })); root.append(rows);
    bindScene(root, 'synthetic-model', () => { reads++; return { draft }; }, value => { draft = value.draft; });
    const input = controls.querySelector('input')!;
    return { root, controls, viewport, renderer, field, select, details, nested, input, get draft() { return draft; }, get reads() { return reads; },
      dispose() { field.dispose(); select.dispose(); root.remove(); disposeScene(document); } };
  }
  const a = mount(); sceneRestoring(document, false);
  const saved: Record<string, unknown>[] = [];
  const observed: string[] = [];
  for (const name of ['input', 'change', 'click', 'toggle', 'scroll', 'pointerup', 'keyup']) a.root.addEventListener(name, event => {
    const element = event.target as HTMLElement; observed.push(`${name}:${element.tagName}:${element.scrollTop}:${element.scrollLeft}`);
  }, true);
  document.addEventListener('selectionchange', () => observed.push(`selection:${document.activeElement?.tagName}`));
  const checkpoints = mountSceneCheckpoints(a.root, () => true, value => saved.push(value));
  let mutations = 0;
  const observer = new MutationObserver(records => { mutations += records.length; });
  observer.observe(a.root, { subtree: true, childList: true, attributes: true, characterData: true });
  const idleStart = performance.now();
  for (let index = 0; index < 1000; index++) {
    a.field.update({ label: 'Draft' });
    a.select.update({ label: 'Container', value: 'app', options: [{ id: 'app', label: 'App' }] });
  }
  await wait(250);
  assert(mutations === 0, `Unchanged SDK controls mutated DOM ${mutations} times`);
  assert(saved.length === 0 && a.reads === 0, 'Idle controls triggered scene capture');
  checks.unchangedControlUpdates = { attempts: 2000, domMutations: mutations, captures: saved.length, elapsedMs: performance.now() - idleStart };
  for (let index = 0; index < 1000; index++) a.renderer.setAttribute('class', `cursor-blink-${index % 2}`);
  a.renderer.textContent = 'Synthetic terminal cells';
  await wait(250);
  assert(saved.length === 0 && a.reads === 0, `Renderer churn triggered scene capture: ${JSON.stringify({ saved: saved.length, reads: a.reads, observed })}`);
  checks.rendererChurn = { mutations: 1001, captures: saved.length };
  a.input.focus();
  for (let index = 0; index < 100; index++) {
    a.input.value = `draft-${index}`;
    a.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  a.input.setSelectionRange(2, 7, 'backward');
  a.details.open = true; a.nested.open = true; a.viewport.scrollTop = 312;
  a.viewport.dispatchEvent(new Event('scroll'));
  await wait(250);
  assert(saved.length === 1, `Input burst created ${saved.length} checkpoints`);
  assert(a.draft === 'draft-99', 'Committed draft lost');
  const snapshot = saved[0]!;
  checks.inputBurst = { events: 100, captures: saved.length, draft: a.draft, geometryEntries: Object.keys(snapshot.geometry as object).length };
  assert(Object.keys(snapshot.geometry as object).length < 20, 'Resource rows were traversed into scene geometry');
  const hidden = document.createElement('section'), output = document.createElement('p'); hidden.hidden = true; hidden.append(output); a.root.append(hidden);
  let paints = 0, latest = '';
  const presentation = visiblePresentation(hidden, () => { paints++; setText(output, latest); });
  for (let index = 0; index < 1000; index++) { latest = String(index); presentation.changed(); }
  assert(paints === 0, 'Hidden view was repainted');
  hidden.hidden = false; sceneChanged(a.root);
  assert(paints === 1 && output.textContent === '999', 'Hidden state did not render once when revealed');
  checks.hiddenUpdates = { updates: 1000, paintsWhileHidden: 0, paintsOnReveal: paints };
  presentation.dispose(); hidden.remove();
  checkpoints.flush();
  const final = captureScene(document, a.root);
  checkpoints.dispose(); observer.disconnect(); a.dispose();
  const b = mount(); sceneRestoring(document, false);
  b.input.value = 'project-b'; b.input.dispatchEvent(new Event('input', { bubbles: true }));
  const bScene = captureScene(document, b.root);
  b.dispose();
  const restored = mount();
  restoreScene(document, restored.root, final); sceneRestoring(document, false);
  assert(restored.input.value === 'draft-99' && restored.draft === 'draft-99', 'A draft not restored after B');
  assert(restored.details.open && restored.nested.open, 'Nested disclosure state not restored');
  assert(restored.viewport.scrollTop === 312, `Scroll not restored: ${restored.viewport.scrollTop}`);
  assert(restored.input.selectionStart === 2 && restored.input.selectionEnd === 7 && restored.input.selectionDirection === 'backward', 'Caret/selection lost');
  assert(document.activeElement === restored.input, 'Focus not restored');
  checks.restoration = { draft: restored.draft, scroll: restored.viewport.scrollTop, selection: [2, 7, restored.input.selectionDirection], nestedDetails: true, focus: true };
  restored.dispose();
  const restoredB = mount(); restoreScene(document, restoredB.root, bScene); sceneRestoring(document, false);
  assert(restoredB.input.value === 'project-b' && restoredB.draft === 'project-b', 'B scene mixed with A');
  restoredB.dispose();
  checks.explorerAndForward = await checkExplorerAndForwardPresentation();
  checks.workbenchAndIcons = await checkWorkbenchAndIcons();
  assert(networkCalls === 0, 'A network call escaped the pure presentation fixture');
  return { status: 'passed', checks, elapsedMs: performance.now() - start, networkCalls, productRuntimeImported: false, operatingChainsExecuted: false };
}
void check().then(result => {
  document.body.replaceChildren();
  const output = document.createElement('pre'); output.id = 'result'; output.textContent = JSON.stringify(result); document.body.append(output);
  document.body.dataset.result = 'passed';
}).catch(error => {
  document.body.replaceChildren();
  const output = document.createElement('pre'); output.id = 'result'; output.textContent = JSON.stringify({ status: 'failed', message: String(error), stack: error instanceof Error ? error.stack : undefined }); document.body.append(output);
  document.body.dataset.result = 'failed';
});
