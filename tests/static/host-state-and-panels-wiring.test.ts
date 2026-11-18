// Source-only: never imports the bridge, SDK or authentication/write executors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { readonlyTestFiles } from '../../scripts/readonly-tests.ts';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the service runtime owns clients; the iframe applies theme but never initializes a new runtime on session changes', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/host/panel-bridge.ts');
  const ready = bridge.slice(bridge.indexOf('const stopReady ='), bridge.indexOf('const stopDirectory ='));
  assert.ok(panel.includes('applyHostReady(context, root)'));
  assert.ok(panel.includes('inspectionSyntaxTheme(context.theme.tokens)'));
  assert.ok(!bridge.includes('connectHost(') && !bridge.includes('HTMLElement'));
  assert.ok(bridge.includes('const viewId = host.workspaceId'));
  assert.ok(ready.includes('lifecycle.ready(context.directory)'));
  assert.ok(ready.includes('if (update.projectChanged) changeProject(context.directory)'));
  assert.match(ready, /if \(update.projectChanged\) \{\s*void client.reload\(\);\s*void preferences.read\(true\);/);
  assert.ok(ready.includes('if (update.initialize) void logPreferences.read()'));
  assert.ok(!/\.reset\(|tree\.clear|projectChanged\(\)/.test(ready));
  assert.ok(ready.includes('else if (localeChanged && current) show'));
  const directory = bridge.slice(bridge.indexOf('const stopDirectory ='), bridge.indexOf('function target()'));
  assert.ok(directory.includes('if (!lifecycle.directory(value)) return'));
  assert.ok(directory.indexOf('return') < directory.indexOf('changeProject(value)'));
  const lifetime = await file('src/host/host-snapshot-lifecycle.ts');
  assert.ok(!/serviceRequest|fetch|storage|session\.|busy|localStorage|setInterval/.test(lifetime.replace(/\/\/[^\n]*/g, '')));
  assert.ok(readonlyTestFiles.includes('tests/readonly/host-snapshot-lifecycle.test.ts'));
});
test('task switching hides mounted panels; it never remounts, closes, refetches or replays operations', async () => {
  const tasks = await file('src/panel/task-tabs.ts'), controls = await file('src/panel/controls.ts'), main = await file('src/panel/main.ts');
  assert.ok(tasks.includes('slot.hidden = key !== active'));
  assert.ok(tasks.includes('scroll.set(active') && tasks.includes('scroll.get(id)'));
  assert.ok(!/serviceRequest|connectHost|fetch\(|localStorage|sessionStorage|\.submit|\.reset\(/.test(tasks));
  assert.ok(controls.includes('update({ value }); props.onChange(value)'));
  assert.ok(controls.includes('changedPresentationProps(current, next)'));
  for (const group of ['sourceTasks', 'helmTasks', 'workspaceTasks', 'clusterTasks', 'sessionTasks']) {
    assert.ok(main.includes(`${group} = mountTaskTabs`), group);
    assert.ok(main.includes(`${group}.slots.`), group);
  }
  assert.ok(main.includes('pageScroll.get(activePageKey)'));
});
test('workspace restoration and disposal cannot invoke business commands or dispose resident clients', async () => {
  const panel = await file('src/host/panel-bridge.ts'), entry = await file('src/panel/entry.ts'), scene = await file('src/panel/workspace-scene.ts');
  const connection = await file('src/host/project-workspace-connection.ts'), runtime = await file('src/service/runtime/project-runtime.ts');
  assert.ok(entry.includes('if (value === directory) return'));
  assert.ok(panel.includes('isSceneRestoring(document)) return Promise.resolve(undefined)'));
  assert.ok(panel.indexOf('root.inert = false; // Focus') < panel.indexOf('restoreScene(document, root'));
  assert.ok(panel.includes('connection.dispose(); host.dispose()'));
  assert.ok(!panel.includes('createProjectRuntime('));
  assert.ok(connection.includes("op: 'detach'") && !/method: 'dispose'|command\('dispose'/.test(connection));
  assert.ok(runtime.includes("!Object.hasOwn(calls, method)") && runtime.includes("method === 'dispose'") && runtime.includes("method === 'saveLogPreferences'"));
  assert.ok(runtime.includes('createProjectRuntime(host'));
  assert.ok(!/dispatchEvent|serviceRequest|fetch\(|localStorage|sessionStorage/.test(scene));
  assert.ok(scene.includes("['model', 'control']") && scene.includes('selectionStart') && scene.includes('scrollTop'));
  assert.ok(scene.includes('lastFocus') && scene.includes('[data-scene-runtime-value]'));
  const main = await file('src/panel/main.ts');
  assert.ok(!main.includes('stopCluster2'));
  assert.ok(panel.includes('deferredEdits') && panel.includes('clipboardPending = true'));
  assert.ok((await file('src/panel/document-view.ts')).includes("editor.setAttribute('data-scene-runtime-value'"));
  assert.ok((await file('src/panel/workspace-view.ts')).includes("editor.setAttribute('data-scene-runtime-value'"));
  assert.ok((await file('src/panel/pod-log-view.ts')).includes('initial.autorun && !isSceneRestoring(document)'));
  const registry = await file('src/service/queries/project-workspaces.ts');
  for (const marker of ['request.sequence !== viewer.sequence + 1', 'request.revision !== workspace.ui.revision', 'pendingCommands >= 64', 'transientLimit', 'timingSafeEqual']) assert.ok(registry.includes(marker), marker);
  const detach = registry.slice(registry.indexOf("if (request.op === 'detach')"), registry.indexOf("if (request.op === 'read')"));
  assert.ok(!/runtime\.|reset\(|close\(/.test(detach));
  const bridge = await file('src/host/bridge.ts');
  assert.ok(bridge.includes('documents.suspend()'));
});
test('normal workspace synchronization is silent without hiding genuine connection failures', async () => {
  const panel = await file('src/host/panel-bridge.ts');
  const save = panel.slice(panel.indexOf('const save ='), panel.indexOf('const checkpoints ='));
  assert.ok(!/banner\.|界面状态同步中|Syncing workspace state/.test(save));
  const checkpoints = await file('src/panel/scene-checkpoints.ts');
  assert.ok(checkpoints.includes('captureScene(document, root)'));
  assert.ok(save.includes('await connection.saveUi(value)'));
  assert.ok(save.includes('catch { failure(); }'));
  const failure = panel.slice(panel.indexOf('const failure ='), panel.indexOf('const effects ='));
  const banner = panel.slice(panel.indexOf('const showBanner ='), panel.indexOf('const updateLanguage ='));
  const messages = await file('src/panel/i18n.ts');
  assert.ok(failure.includes("showBanner('workspace.disconnected')"));
  assert.ok(banner.includes('banner.hidden = false') && banner.includes('banner.textContent = panelText'));
  assert.ok(messages.includes('工作区连接中断') && messages.includes('请勿重复提交操作'));
});
test('renderer mutations cannot recursively trigger full scene capture; final memory is captured before teardown', async () => {
  const panel = await file('src/host/panel-bridge.ts'), checkpoints = await file('src/panel/scene-checkpoints.ts'), scene = await file('src/panel/workspace-scene.ts'), main = await file('src/panel/main.ts');
  assert.ok(!/MutationObserver|observer\.observe/.test(panel + checkpoints));
  assert.ok(checkpoints.includes('setTimeout(flush, 120)') && checkpoints.includes("onSceneChange(document, reason => { if (reason === 'state') checkpoint(); })"));
  assert.ok(!scene.includes("querySelectorAll<HTMLElement>('*')") && scene.includes("'details,input,textarea,select'"));
  assert.ok(panel.includes('checkpoints.flush()') && panel.includes('Promise.resolve(finalSave).finally'));
  const dispose = main.slice(main.indexOf('const dispose = () =>'));
  assert.ok(dispose.indexOf('bridge?.dispose()') < dispose.indexOf('disposeScene(document)'));
  assert.ok(panel.includes('samePresentation(appearance, next)'));
});
test('every right panel is inventoried; user-facing descriptions are brief and contain no engineering phase prose', async () => {
  const names = (await readdir(new URL('../../src/panel/', import.meta.url))).filter(name => name.endsWith('view.ts'));
  assert.equal(names.length, 60);
  assert.ok(names.includes('session-terminal-view.ts'));
  for (const name of names) {
    const code = await file(`src/panel/${name}`);
    for (const match of code.matchAll(/note\.textContent\s*=\s*zh\s*\?\s*'([^']*)'/g)) {
      assert.ok((match[1]?.length ?? 0) <= 100, `${name}: description is too long`);
      assert.ok(!/G4|B-01|worker|账本|有限2槽|通道0|实际.*写入口|未接|非最终/.test(match[1] ?? ''), `${name}: internal prose`);
    }
    if (/mountTextField|mountSelect/.test(code)) assert.ok(!/^import .*mount(?:TextField|Select).*from '@openchamber\/sdk\/ui'/m.test(code), `${name}: must commit draft values before repaint`);
  }
});
test('logs have separate compact read/search/filter/preferences controls and no duplicated visible wrap/follow defaults', async () => {
  const logs = await file('src/panel/pod-log-view.ts'), text = await file('src/panel/log-text-view.ts'), css = await file('assets/panel/main.css');
  assert.ok(logs.includes('runConfigured(false)'));
  assert.ok(logs.includes('settings.body.prepend(followLabel, autoLabel, destinationSlot)'));
  assert.ok(!logs.includes('fields.append(followLabel'));
  assert.ok(!logs.includes('wrapLabel, destinationSlot'));
  assert.ok(text.includes('advanced.body.append(filterSlot, modeSlot, ansiLabel, advancedActions)'));
  assert.ok(text.includes('fields.append(searchSlot, wrapLabel)'));
  assert.ok(logs.includes('output.hidden = destination === \'Terminal\' || following'));
  assert.ok(!css.includes('max-height: 18rem'));
  assert.ok(!text.includes('var(--oc-foreground)') && !text.includes('var(--oc-background)'));
});
test('operation summaries keep unknown results, targets, changes and risk warnings outside proof disclosures', async () => {
  const summary = await file('src/panel/presentation.ts');
  for (const marker of ["'unknown'", "'accepted'", "'succeeded'", '目标副本数', 'scope.context', 'reference.name', '确认有效至', '临时文件残留']) assert.ok(summary.includes(marker), marker);
  assert.ok(!/innerHTML|localStorage|sessionStorage|JSON.stringify\(state/.test(summary));
  for (const name of ['scale', 'expose', 'cronjob-run', 'config-file-add', 'config-file-delete', 'file-delete', 'file-save', 'manifest-create', 'manifest-apply', 'apply-file', 'image-run', 'git-sync', 'merge-kubeconfig', 'context', 'context-delete', 'namespace', 'namespace-delete', 'preference', 'delete']) {
    assert.ok((await file(`src/panel/${name}-view.ts`)).includes('mountOperationSummary'), name);
  }
});
