// Text/metadata only. Never import or invoke the parameterise reader/client/transform, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the parameterise chain: reference, values entry, two-buffer edits', async () => {
  const authoring = await file('tests/fixtures/baseline/kubernetes/src/helm.authoring.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(authoring.includes('export async function convertToParameter('));
  assert.ok(authoring.includes("'Active document is not a Helm template'") && authoring.includes("'Selection is not a YAML field'"));
  assert.ok(authoring.includes('`{{ .Values.${keyReference} }}`'));
  assert.ok(authoring.includes('const rawKeyPath = [templateName, valueSymbolContainmentChain[0].name];'));
  assert.ok(authoring.includes('const valuesYamlPath = path.normalize(path.join(path.dirname(template.fileName), \'..\', \'values.yaml\'));'));
  assert.ok(authoring.includes("fs.writeFileSync(valuesYamlPath, '');"));
  assert.ok(authoring.includes('function applyEdits('));
  assert.ok(extension.includes("registerCommand('extension.helmParameterise'"));
});
test('pure projections live in shared: key reference, parameter reference, entry shape', async () => {
  const shared = await file('src/shared/helm-parameterise-protocol.ts');
  for (const part of ['export function keyReference(template: string, field: string)', 'export function parameterReference(template: string, field: string)', 'export function entryText(template: string, field: string, value: string)', '${template}:\\n  ${field}: ${value}\\n']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the parsing transform is a bounded pure text transform with explicit ambiguity', async () => {
  const code = await file('src/parsing/helm-parameterise-transform.ts');
  for (const part of ["import { entryText, parameterReference } from '../shared/helm-parameterise-protocol.ts'", 'export function parameteriseDocument(documentText: string, template: string, field: string, value: string)', 'lineBudget = 4000', "matches.length === 0", "matches.length > 1", 'containsDisallowedControlCharacters']) assert.ok(code.includes(part), part);
  assert.ok(!/writeFile|readFile|spawn|console\./.test(code));
});
test('the reader is a pure computation wired over the 48KB route', async () => {
  const reader = await file('src/service/queries/helm-parameterise-reader.ts'), main = await file('src/service/runtime/main.ts'), http = await file('src/service/runtime/http.ts');
  for (const part of ['parameteriseDocument(parsed.data.document, parsed.data.template, parsed.data.field, parsed.data.value)', 'keyReference(parsed.data.template, parsed.data.field)']) assert.ok(reader.includes(part), part);
  assert.ok(!/writeFile|spawn|console\.|scheduler/.test(reader));
  assert.ok(main.includes('createHelmParameteriseReader()'));
  const offset = http.indexOf("url.pathname === '/v2/helm/parameterise'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmParameterises.read(input, controller.signal)') && http.includes('options.helmParameterises.close()'));
});
test('the client and view never edit, write or copy — both texts are display-only', async () => {
  const client = await file('src/host/helm-parameterise-client.ts'), view = await file('src/panel/helm-parameterise-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ["path: '/v2/helm/parameterise'", 'response.body.length > 96_000']) assert.ok(client.includes(part), part);
  assert.ok(!/applyEdit|clipboard|writeText|execCommand|insertSnippet/.test(client + view));
  for (const part of ['bridge()?.runHelmParameterise(template.input.value.trim(), fieldName.input.value.trim(), value.input.value.trim(), source.value)', 'uniquely matching field', 'nothing is saved automatically', "field('mychart (template/chart name)', 128)", "field('replicas (YAML field name)', 128)", "field('3 (the literal field value)', 1024)", 'source.maxLength = 46_080']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmParameterise: (template: string, field: string, value: string, document: string)') && bridge.includes('closeHelmParameterise: () => helmParameterises?.reset()'));
});
test('automatic dependency graphs forbid the new client/view from readonly roots; suites are registered', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-parameterise-values.test.ts');
  for (const part of ['helm-parameterise-client', 'helm-parameterise-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/|operations\/helm|runtime\/|helm-parameterise-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-parameterise-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-parameterise-wiring.test.ts'"));
});
