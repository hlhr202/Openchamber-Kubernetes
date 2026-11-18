// Text/metadata only. Never import or invoke the write adapter/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves the templatise/cleanse/quoting chain and the template write', async () => {
  const authoring = await file('tests/fixtures/baseline/kubernetes/src/helm.authoring.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(authoring.includes("const NAME_EXPRESSION = '{{ template \"fullname\" . }}';"));
  assert.ok(authoring.includes("const CHART_LABEL_EXPRESSION = '{{ .Chart.Name }}-{{ .Chart.Version | replace \"+\" \"_\" }}';"));
  assert.ok(authoring.includes('delete template.status;') && authoring.includes('template.metadata.name = NAME_EXPRESSION;'));
  assert.ok(authoring.includes("'kubectl.kubernetes.io/last-applied-configuration'"));
  assert.ok(authoring.includes('delete metadata.resourceVersion;') && authoring.includes('delete metadata.uid;'));
  assert.ok(authoring.includes('path.join(chart.path, "templates", templateName + ".yaml")'));
  assert.ok(authoring.includes('context.fs.writeFileSync(templateFile, templateText);'));
  assert.ok(authoring.includes('function fixYamlValueQuoting(yamlText: string): string {'));
  assert.ok(extension.includes("registerCommand('extension.helmConvertToTemplate'"));
});
test('pure projections live in shared: canonical template path, bounded tokens, fixed codes', async () => {
  const shared = await file('src/shared/helm-convert-protocol.ts');
  for (const part of ['export function templateFilePath(root: string, path: string, name: string)', '/templates/${name}.yaml', 'export function convertFailureCode(error: unknown)', "'DOCUMENT_DIRTY'", 'NEVER overwritten']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the parsing transform is the strict portable port with bounds on both ends', async () => {
  const code = await file('src/parsing/helm-template-transform.ts');
  for (const part of ["import { parse, stringify } from 'yaml'", 'export const NAME_EXPRESSION', 'export const CHART_LABEL_EXPRESSION', 'METADATA_TO_STRIP', 'ANNOTATIONS_TO_STRIP', 'export function convertToTemplateText(documentText: string): string', 'export function fixYamlValueQuoting(yamlText: string): string', '46_080']) assert.ok(code.includes(part), part);
  assert.ok(!/writeFile|readFile|spawn|console\./.test(code));
});
test('the write adapter is one exclusive new-file write that never overwrites', async () => {
  const code = await file('src/service/adapters/helm-template-write.ts');
  for (const part of ["mkdir(templatesDirectory, { recursive: true })", "writeFile(destination, input.text, { flag: 'wx' })", "'EEXIST'", "throw new BoundaryError('DOCUMENT_DIRTY')", 'posix.join(templatesDirectory, `${input.name}.yaml`)']) assert.ok(code.includes(part), part);
  assert.ok(!/unlink|rmSync|console\.|setInterval/.test(code));
});
test('operations transform first, then write once; runtime wires and authenticates the 48KB route', async () => {
  const operations = await file('src/service/operations/helm-convert.ts'), main = await file('src/service/runtime/main.ts'), http = await file('src/service/runtime/http.ts');
  for (const part of ['convertToTemplateText(parsed.data.document)', "if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'convertFailureCode(error)']) assert.ok(operations.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|spawn/.test(operations));
  assert.ok(main.includes('createHelmConvertOperations({ run: createHelmTemplateWriteRunner() })'));
  const offset = http.indexOf("url.pathname === '/v2/helm/convert-template'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmConverts.handle(input, controller.signal)') && http.includes('options.helmConverts.close()') && http.slice(offset, offset + 400).includes('48_000'));
});
test('the panel view discloses exclusive-write, no-auto-create and no-auto-open semantics', async () => {
  const view = await file('src/panel/helm-convert-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmConvert(root.value.trim(), path.value.trim(), name.value.trim(), source.value)', 'name.maxLength = 128', 'source.maxLength = 46_080', 'Existing files are not overwritten', 'nothing is applied']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmConvert: (root: string, path: string, name: string, document: string)') && bridge.includes('closeHelmConvert: () => helmConverts?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-convert-values.test.ts');
  for (const part of ['helm-template-write', 'helm-convert-client', 'helm-convert-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-template-write|operations\/helm-convert|runtime\/|helm-convert-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-convert-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-convert-wiring.test.ts'"));
});
