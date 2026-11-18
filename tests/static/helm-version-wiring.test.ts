// Text/metadata only. Never import or invoke the Helm CLI runner/client, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream helm.exec text proves the probe order, the -c split and the global-cache hazard', async () => {
  const body = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt');
  for (const part of ['export async function helmVersion()', 'version --short -c', "stdout.indexOf('v2')", "stdout.indexOf('v4')", "stdout.indexOf('v3')", "let cachedVersion", "versionArgs = (syntaxVersion === HelmSyntaxVersion.V3 || syntaxVersion === HelmSyntaxVersion.V4) ? '' : '-c'"]) assert.ok(body.includes(part), part);
});
test('the CLI runner probes on every read with no global cache and an isolated PATH-only environment', async () => {
  const code = await file('src/service/adapters/helm-version-cli.ts');
  for (const part of ["['version', '--short', '-c']", "['version', '--short']", 'helmVersionArguments(syntax)', "env: { PATH: path, HOME: '/var/empty' }", "cwd: '/var/empty'", 'shell: false', 'detached: true', 'SIGKILL', '16_384']) assert.ok(code.includes(part), part);
  assert.ok(!/cachedVersion|let cache|HELM_REPOSITORY|XDG_|writeFile|console\.|setInterval/.test(code));
  assert.ok(code.includes('No kubeconfig, no cluster, no plugin/config load'));
});
test('the service reader is bounded by the finite scheduler and never surfaces raw CLI stderr', async () => {
  const code = await file('src/service/queries/helm-version-reader.ts');
  for (const part of ['concurrency: 2, queued: 8, consumers: 32, timeoutMs: 7000', "'helm-version-unavailable'", "'unknown' as const", "kind: 'helm-version' as const"]) assert.ok(code.includes(part), part);
  assert.ok(!/console\.|writeFile|spawn\(/.test(code));
});
test('runtime authenticates the read route with a tiny body bound; the client never caches a syntax across reads', async () => {
  const http = await file('src/service/runtime/http.ts'), client = await file('src/host/helm-version-client.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/version'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmVersions.read(input, controller.signal)') && http.includes('options.helmVersions.close()'));
  for (const part of ["path: '/v2/helm/version'", 'helmVersionResponseSchema.safeParse(value)', '#calls >= 1', "this.#paint('reading')"]) assert.ok(client.includes(part), part);
  assert.ok(!/setInterval|storage\.|writeClipboard|console\./.test(client));
});
test('the panel view is an explicit read-only button that discloses the probe and its non-approval', async () => {
  const view = await file('src/panel/helm-version-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.readHelmVersion()', 'without connecting to a cluster or installing software', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(bridge.includes('onHelmVersion:') && bridge.includes('helmVersions?.read()'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view));
});
test('readonly suites cover only the pure shared protocol; the spawn adapter stays out of every allowlist', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-version-values.test.ts');
  assert.ok(check.includes('helm-version-cli')); // forbidden for read/display imports
  assert.ok(!/from ['"].*(?:adapters\/|runtime\/|helm-version-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-version-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-version-wiring.test.ts'"));
});
