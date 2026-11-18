// Text/metadata only. Never import or invoke the Helm release client/view/reader route, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the read path stays a fixed gated purpose: one namespace, owner=helm, 100 per page, 3 pages max', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts');
  const gate = plan.slice(plan.indexOf("request.purpose === 'helm-releases'"), plan.indexOf("request.purpose === 'cluster-info'"));
  for (const part of ["remaining[0] !== 'namespaces'", "remaining[1] !== request.target.namespace", "remaining[2] !== 'secrets'", "request.query.limit !== '100'", "request.query.labelSelector === 'owner=helm'", 'owner=helm,name=', "['limit', 'labelSelector', 'continue']"]) assert.ok(gate.includes(part), part);
  const secret = await file('src/service/queries/helm-release-secret.ts');
  for (const part of ['gunzipSync', 'maxOutputLength: helmReleaseMaxBytes', "z.literal('helm.sh/release.v1')", 'helmReleaseSecretName(decoded.name, decoded.revision)', 'pages++ >= 3']) assert.ok(secret.includes(part), part);
  assert.ok(!/writeFile|execFile|spawn|console\.|setInterval/.test(secret));
});
test('the query runs through the shared read scheduler and re-proves the target before and after', async () => {
  const reader = await file('src/service/queries/resource-reader.ts');
  const method = reader.slice(reader.indexOf('    async helmReleases('), reader.indexOf('    async resolveLocator('));
  for (const part of ["key(target, 'helm-releases', randomUUID())", 'readHelmReleaseRevisions(target, sharedSignal, read, () => verify(target, sharedSignal), releaseName)', 'freezeResult(value)']) assert.ok(method.includes(part), part);
  const gateway = await file('src/service/queries/resource-gateway.ts');
  const gate = gateway.slice(gateway.indexOf('    async readHelmReleases('), gateway.indexOf('    async resolveLocator('));
  for (const part of ['helmReleaseRequestSchema.safeParse(input)', 'groupHelmReleases', 'helmReleaseResponseSchema.parse']) assert.ok(gate.includes(part), part);
});
test('runtime authenticates the route and the panel exposes one explicit read with no write surface', async () => {
  const http = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/helm-release-view.ts'), main = await file('src/panel/main.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/releases/read'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.resources.readHelmReleases(input, controller.signal)'));
  assert.ok(bridge.includes('new HelmReleaseClient') && bridge.includes('void helmReleases?.read(target(), client.selection, namespace)'));
  assert.ok(view.includes('bridge()?.readHelmReleases(namespace)') && !/innerHTML|writeClipboard|storage\./.test(view));
  assert.ok(main.includes('mountHelmReleaseView') && main.includes('bridge.onHelmRelease('));
});
test('readonly suites never reach the client/view; the new suite is registered', async () => {
  const readonly = await file('tests/readonly/helm-release-values.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|helm-release-client|bridge|sdk)/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-release-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-release-wiring.test.ts'"));
});
