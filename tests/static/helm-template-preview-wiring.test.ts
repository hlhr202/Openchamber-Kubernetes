// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: editor and template gates, fixed URI, version branch, save refresh', async () => {
  const extension = await source('extension.ts'), exec = await source('helm.exec.ts'), provider = await source('helm.documentProvider.ts');
  assert.ok(extension.includes("registerCommand('extension.helmTemplatePreview', helmexec.helmTemplatePreview)"));
  const command = exec.slice(exec.indexOf('export function helmTemplatePreview()'), exec.indexOf('export function helmDepUp'));
  assert.ok(command.includes('vscode.window.showInformationMessage("No active editor.")'));
  assert.ok(command.includes('filePath.indexOf("templates") < 0'));
  assert.ok(command.includes('"Not a template: " +filePath'));
  assert.ok(command.includes('ensureHelm(EnsureMode.Alert)'));
  assert.ok(command.includes('vscode.Uri.parse(helm.PREVIEW_URI)'));
  assert.ok(command.includes('vscode.ViewColumn.Two'));
  assert.ok(command.includes('Preview ${ f }'));
  assert.ok(command.includes('helm.recordPreviewHasBeenShown()'));
  const content = provider.slice(provider.indexOf('public provideTextDocumentContent'));
  assert.ok(content.includes('"FIXME: no editor selected"'));
  assert.ok(content.includes('exec.pickChartForFile(tpl, { warnIfNoCharts: true }, (chartPath)'));
  assert.ok(content.includes('filepath.relative(chartPath, tpl)'));
  assert.ok(content.includes('subtitle: "Failed template call"'));
  assert.ok(content.includes('filepath.basename(reltpl) !== "NOTES.txt"'));
  assert.ok(content.includes('YAML failed to parse: ${ errorMessage }'));
  assert.ok(content.includes('template "${chartPath}" --show-only "${reltpl}"'));
  assert.ok(content.includes('template "${chartPath}" --execute "${reltpl}"'));
  assert.ok(content.includes(`content: 'Helm template produced no output', isErrorOutput: true`));
  const save = extension.slice(extension.indexOf('vscode.workspace.onDidSaveTextDocument'), extension.indexOf('// On editor change, refresh the Helm YAML preview'));
  assert.ok(save.includes('WARNING: No active editor during save. Helm preview was not updated.'));
  assert.ok(save.includes('e === activeTextEditor.document'));
  assert.ok(save.includes('doc.uri.scheme !== "file"'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/helm-template-preview-protocol.ts');
  for (const part of ["return 'No active editor.';", "return 'Not a template: ' + filePath;", 'return `Preview ${basename}`;', "return 'FIXME: no editor selected';", "return 'WARNING: No active editor during save. Helm preview was not updated.';", 'return `YAML failed to parse: ${errorMessage}`;', "return 'Helm template produced no output';", "return 'Chart Preview';", "return 'Failed template call';", "version === 3 || version === 4 ? ['template', `\"${chartPath}\"`, '--show-only', `\"${reltpl}\"`] : ['template', `\"${chartPath}\"`, '--execute', `\"${reltpl}\"`]", "=== 'NOTES.txt'", "return hasActiveEditor && savedIsActiveDocument && scheme === 'file';", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'a dirty buffer is never', 'never another file\'s execution', 'never crosses active editors or projects', 'never becomes an auto-verify authorisation', 'No automated execution exists', 'anywhere.']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for template preview', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('template-preview'));
  assert.ok(!bridge.includes('TemplatePreviewClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.helmTemplatePreview');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M6-E077');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/helm-template-preview-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-template-preview-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-template-preview-wiring.test.ts'"));
});
