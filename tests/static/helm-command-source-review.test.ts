// Pinned source TEXT only. Never import upstream Helm/VS Code, plugin operations, CLI or adapters.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('all nineteen Helm command registrations point at reviewed reachable handlers, not similarly named legacy modules', async () => {
  const extension = await source('extension.ts'), coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; evidence?: string; implementation: string; candidateId: string | null }[] };
  const entries = coverage.entries.filter(e => e.evidence === 'M1-E055'); assert.equal(entries.length, 19);
  for (const e of entries) { assert.ok(extension.includes(`'${e.commandId}'`) || extension.includes(`"${e.commandId}"`)); if (!['extension.helmVersion', 'extension.helmInspectChart', 'extension.helmFetchValues', 'extension.helmDependencies', 'extension.helmLint', 'extension.helmTemplate', 'extension.helmDryRun', 'extension.helmPackage', 'extension.helmDepUp', 'extension.helmCreate', 'extension.helmFetch', 'extension.helmInsertReq', 'extension.helmConvertToTemplate', 'extension.helmParameterise', 'extension.helmGet', 'extension.helmInstall', 'extension.helmUninstall', 'extension.helmRollback', 'extension.helmTemplatePreview'].includes(e.commandId)) { assert.equal(e.implementation, 'not-started'); assert.equal(e.candidateId, null); } } // E034/E038-E054/M6-E055 delivered these nineteen as reviewed partials (helmGet/helmInstall/helmUninstall/helmRollback/helmTemplatePreview ship protocol+static review with server execution deferred).
});
test('version probes retain syntax-only v2/v3/v4 detection, and missing-tool helper offers install/config mutations', async () => {
  const exec = await source('helm.exec.ts'); for (const text of ['version --short -c', 'version --short', 'cachedVersion', 'offersInstall: true', 'installDependencies();', 'setSuppressHelmNotFound(true)']) assert.ok(exec.includes(text));
});
test('Template/Lint/Dependency Update/Dry Run are real CLI paths with chart picker, not automatic pure previews', async () => {
  const exec = await source('helm.exec.ts'); for (const text of ['template "${path}"', 'lint "${path}"', 'dep up "${path}"', 'install ${dryRunArg} ${generateNameArg} --debug', '"**/Chart.yaml", "**/node_modules/**", 1024']) assert.ok(exec.includes(text));
});
test('Preview uses active saved-file path and version-specific show-only/execute, not captured dirty text', async () => {
  const exec = await source('helm.exec.ts'), provider = await source('helm.documentProvider.ts'), extension = await source('extension.ts');
  assert.ok(exec.includes('filePath.indexOf("templates") < 0') && provider.includes('vscode.window.activeTextEditor.document.fileName'));
  assert.ok(provider.includes('--show-only "${reltpl}"') && provider.includes('--execute "${reltpl}"') && extension.includes('previewProvider.update(u)'));
});
test('Fetch values repo branch resolves raw virtual content; file authority is not implemented by its registered provider', async () => {
  const exec = await source('helm.exec.ts'), provider = await source('helm.documentProvider.ts'), preview = await source('utils/preview.ts'), extension = await source('extension.ts');
  const values = provider.slice(provider.indexOf('export class HelmValuesDocumentProvider'), provider.indexOf('// Provide an HTML-formatted preview'));
  assert.ok(exec.includes('inspectionScheme: helm.FETCH_VALUES_SCHEME') && values.includes('uri.authority === helm.INSPECT_REPO_AUTHORITY') && values.includes('resolve(out)'));
  assert.ok(!values.includes('writeFile') && !values.includes('INSPECT_FILE_AUTHORITY') && preview.includes('vscode.window.showTextDocument(document)') && extension.includes('registerTextDocumentContentProvider(helm.FETCH_VALUES_SCHEME'));
});
test('Dependencies fetches an archive into an owned temp directory before dep list and explicitly cleans it, unlike a pure index query', async () => {
  const exec = await source('helm.exec.ts'); const body = exec.slice(exec.indexOf('export async function helmDependenciesCore'), exec.indexOf('// pickChart tries'));
  assert.ok(body.indexOf('fetch ${chartId}') < body.indexOf('dep list "${chartPath}"')); assert.ok(body.includes('tempDirFiles[0]') && body.includes('fs.unlinkSync(chartPath)') && body.includes('tempDirObj.removeCallback()') && body.includes('has no dependencies'));
});
test('Fetch and Create write the chosen workspace and Package writes the selected destination rather than plugin cache', async () => {
  const exec = await source('helm.exec.ts'); for (const text of ['filepath.join(folder.uri.fsPath, name)', 'create "${fullpath}"', 'fetch ${chartId} --untar ${versionArg} -d "${destinationDir}"', 'package "${path}" -d "${packagePath[0].fsPath}"']) assert.ok(exec.includes(text));
});
test('Install generates release names without a release/values picker, while Uninstall and Rollback have explicit warnings', async () => {
  const exec = await source('helm.exec.ts'); assert.ok(exec.includes('install ${chartId} ${versionArg} ${nsArg} ${generateNameArg}') && exec.includes("'--generate-name'"));
  assert.ok(exec.includes('del ${releaseName}') && exec.includes('rollback ${releaseName} ${release.revision} --cleanup-on-fail') && exec.includes('resourceNode.release.status === "deployed"'));
});
test('Get Release/revision URI omits namespace/context and virtualfs dispatches get all without the parsed namespace', async () => {
  const exec = await source('helm.exec.ts'), vfs = await source('kuberesources.virtualfs.ts'); const uri = exec.slice(exec.indexOf('export function helmfsUri'), exec.indexOf('// helmPackage'));
  assert.ok(uri.includes('?value=${releaseName}${revisionQuery}&_=${nonce}') && !uri.includes('context') && !uri.includes('namespace'));
  assert.ok(vfs.includes('get ${scopearg} ${value}${revarg}') && vfs.includes('` --revision=${revision}`'));
});
test('Insert Dependency uses legacy HELM_HOME files and first indexed version, then inserts a snippet into the active buffer', async () => {
  const exec = await source('helm.exec.ts'); for (const text of ['ed.insertSnippet(new vscode.SnippetString(req.toString()))', 'YAML.load(repo.cache)', 'releases[0].version', 'process.env["HELM_HOME"]']) assert.ok(exec.includes(text));
});
test('Convert to Template writes without collision checks after possible chart creation; parameterization edits two buffers and may first create values.yaml', async () => {
  const author = await source('helm.authoring.ts'); assert.ok(author.indexOf('await pickOrCreateChart(context)') < author.indexOf('Name for the new template'));
  for (const text of ['// TODO: check if file already exists', 'context.fs.writeFileSync(templateFile, templateText)', 'delete template.status', 'fs.writeFileSync(valuesYamlPath, \'\')', 'vscode.workspace.applyEdit(wsEdit)', 'findCreatableKeyPathBySuffixing']) assert.ok(author.includes(text));
});
