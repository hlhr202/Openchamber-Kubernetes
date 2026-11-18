// TEXT ONLY. Static structural verification for RX resource explorer, menu wiring, and request-control gates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readonlyTestFiles } from '../../scripts/readonly-tests.ts';

const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('RX-A01 / RX-A06 / RX-A16: panel main.ts uses resource-tree-first workbench, routes sub-views on demand, and has no slice(0, 12) truncation', async () => {
  const main = await file('src/panel/main.ts');
  assert.ok(main.includes('oc-k8s-workbench'), 'workbench root container present');
  assert.ok(main.includes('mountTreeView'), 'Clusters tree view mounted');
  assert.ok(main.includes('mountHelmRepoTreeView'), 'Helm Repos tree view mounted');
  assert.ok(main.includes('mountRequestDiagnosticsView'), 'Request diagnostics view mounted on demand');
  assert.equal(main.includes('.slice(0, 12)'), false, 'must not silently truncate menu items with slice(0, 12)');
  for (const wiring of [
    'openPodLog(',
    'openJobLog(',
    'readDocument(',
    'readInspection(',
    'readKeyContent(',
    'readEvents(',
    'prepareDelete({ reference',
    'scale.target(',
    'cronJobRun.target(',
    'expose.target(',
    'helmRelease.targetAction(',
    'terminalSession.target(',
    'configFileAdd.target(',
    'configFileDelete.target(',
  ]) {
    assert.ok(main.includes(wiring), `expected direct node target wiring: ${wiring}`);
  }
});

test('RX-A08: pure explorer-actions module has no RBAC/container/port pre-probing and no execution/host imports', async () => {
  const actions = await file('src/shared/explorer-actions.ts');
  assert.equal(/\/host\/|\/service\/|\/panel\//.test(actions), false);
  assert.equal(/canI|SelfSubjectAccessReview|auth\/v1|getContainers|checkPort/.test(actions), false);
  assert.ok(actions.includes('explorerTitleActions') && actions.includes('explorerNodeActions'));
  assert.ok(actions.includes("node.type === 'resource'"));
  assert.ok(actions.includes('extension.vsKubernetesDelete'));
});

test('RX-A10 / RX-A17: HTTP runtime exposes authenticated sanitized /v2/status/requests and shares gateway outbound gate', async () => {
  const http = await file('src/service/runtime/http.ts');
  const gateway = await file('src/service/queries/resource-gateway.ts');
  assert.ok(http.includes("'/v2/status/requests'"), 'sanitized request diagnostics route registered');
  assert.ok(http.includes('options.resources.diagnostics()'), 'diagnostics route reads shared gateway telemetry');
  assert.ok(gateway.includes('createOutboundReadGate'), 'gateway creates shared outbound read gate');
  assert.ok(gateway.includes('frozenRxReadLimits') || (await file('src/service/queries/outbound-read-gate.ts')).includes('frozenRxReadLimits'));
});

test('RX readonly test files are allowlisted and never import forbidden write/runtime/tree-view boundaries', async () => {
  for (const name of ['tests/readonly/rx-request-control.test.ts', 'tests/readonly/rx-explorer-dom.test.ts']) {
    assert.ok(readonlyTestFiles.includes(name), `${name} must be in readonlyTestFiles`);
    const content = await file(name);
    assert.equal(/service\/(operations|sessions|runtime)\/|panel\/tree-view\.ts/.test(content), false, `${name} must not import write/runtime/tree-view`);
  }
});
test('home initializes explorer before insertion and fills viewport without nested default details or fixed tree height', async () => {
  const main = await file('src/panel/main.ts'), css = await file('assets/panel/main.css'), tree = await file('src/panel/tree-view.ts');
  assert.ok(main.indexOf("workbench.dataset.route = 'explorer'") < main.indexOf('root.replaceChildren(workbench)'));
  assert.ok(css.includes('height: 100dvh'));
  assert.ok(css.includes('height: 100%; min-width: 0; min-height: 0;'));
  assert.ok(!css.includes('max-height: 40em') && !css.includes('max-height: 44em'));
  assert.ok(tree.includes('detail.hidden = true') && tree.includes('handle.hidden = true'));
  assert.ok(tree.includes('!detail.hidden && !focusInDetail'));
  assert.ok(css.includes('.oc-k8s-tree-split[data-detail="true"] > .oc-k8s-tree-pane'));
});

test('explorer colours use SDK theme tokens with paired selection foreground and no unused tree navigation', async () => {
  const css = await file('assets/panel/main.css'), sdk = await file('tests/fixtures/baseline/openchamber/packages/sdk/src/ui/theme.ts.txt');
  const tokens = new Set([...sdk.matchAll(/'(--oc-[\w-]+)'/g)].map(match => match[1]));
  for (const match of css.matchAll(/var\((--oc-[\w-]+)/g)) {
    if (!match[1]?.startsWith('--oc-k8s-')) assert.ok(tokens.has(match[1]), `unrecognized SDK token ${match[1]}`);
  }
  assert.ok(css.includes('background: var(--oc-selection); color: var(--oc-selection-fg)'));
  assert.ok(!/background:\s*var\(--oc-muted(?:,|\))/.test(css));
  assert.ok(css.includes('flex: 0 0 auto') && css.includes('white-space: nowrap') && !css.includes('.oc-k8s-tree-crumbs'));
  for (const token of ['--oc-success-text', '--oc-warning-text', '--oc-error-text', '--oc-k8s-code-key', '--oc-k8s-code-number']) assert.ok(css.includes(token));
  const bridge = await file('src/host/panel-bridge.ts');
  assert.ok(bridge.includes('inspectionSyntaxTheme(context.theme.tokens)'));
});

test('inspection has brief human-readable copy and safe theme-coloured output, not implementation notes', async () => {
  const view = await file('src/panel/inspection-view.ts'), highlight = await file('src/panel/inspection-text.ts');
  for (const phrase of ['CLI单个', '1MiB/60', 'snapshot', 'discovery', '有限2槽']) assert.ok(!view.includes(phrase), phrase);
  assert.ok(view.includes("document.createElement('details')") && view.includes('查看资源详情、容器状态和最近事件'));
  assert.ok(view.includes('nextSlot.hidden') && view.includes('cancelSlot.hidden'));
  assert.ok(highlight.includes('span.textContent = token.text') && !/innerHTML|insertAdjacentHTML|createElement\(['"]a/.test(highlight));
  assert.ok(view.includes('renderedText !== state.text') && !/setInterval|fetch\(|serviceRequest/.test(view + highlight));
});
