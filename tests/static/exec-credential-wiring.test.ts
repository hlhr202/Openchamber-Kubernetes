// TEXT ONLY. Never import/invoke authentication or its mocked executor.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('exec authentication executes kubeconfig command on demand without a second authorization step or raw error output', async () => {
  const code = await file('src/service/adapters/exec-credential.ts');
  for (const part of ["import { execFile } from 'node:child_process'", 'shell: false', 'windowsHide: true',
    'execCredentialCacheLimits.runTimeoutMs', 'execCredentialCacheLimits.stdoutMaxBytes', 'execCredentialRequestDocument',
    'child.stdin?.end()', 'signal.removeEventListener', 'if (signal.aborted) abort()', 'result.data.apiVersion !== spec.apiVersion',
    "child.kill('SIGKILL')", 'env.KUBECONFIG = environment.KUBECONFIG', 'AUTH_PLUGIN_NOT_FOUND']) assert.ok(code.includes(part), part);
  assert.ok(!/authorize\(|authorized\.|process\.env|writeFile|appendFile|console\.|setInterval/.test(code));
  assert.ok(!/error\.message|error\.stderr|stdout\.slice/.test(code));
});
test('automatic provider binds target before exec, shares one cancellable flight and publishes bounded memory credentials only', async () => {
  const code = await file('src/service/adapters/automatic-credentials.ts');
  for (const part of ['execAuthenticationInput(config)', 'privateKubectlConfiguration({ ...config, users }, target)',
    'cache.has(identity, config.currentContext)', 'flights.join(key)', 'lease.created', 'executeCredentialPlugin(spec',
    'flights.usable(lease.ticket)', 'cache.put(identity, config.currentContext', 'flights.leave(lease.ticket, lease.consumer)',
    'owned.controller.abort()', 'flights.settle(lease.ticket)', 'failures.set(key', 'cache.clear()']) assert.ok(code.includes(part), part);
  assert.ok(code.indexOf('privateKubectlConfiguration(') < code.indexOf('executeCredentialPlugin(spec'));
  assert.ok(!/console\.|writeFile|appendFile|\.\.\.process\.env/.test(code));
  const runtime = await file('src/service/runtime/main.ts'), config = await file('src/service/queries/config-source.ts');
  assert.ok(runtime.includes('createConfigReader(defaultPaths, undefined, credentials.resolve, credentials.reject)'));
  assert.ok(runtime.includes('credentials.close()'));
  assert.ok(config.includes('await transportCredentials(result.merged, expectedIdentity, signal, target)'));
  assert.ok(config.includes('fresh.publicRead.snapshot.configIdentity !== expectedIdentity'));
  assert.ok(code.includes("'CLOUDSDK_CONFIG'") && code.includes("'CLOUDSDK_ACTIVE_CONFIG_NAME'"));
});
test('all transport reads pass the frozen target and invalidate rejected credentials without replaying a write', async () => {
  for (const path of ['kubectl-read', 'kubectl-watch', 'kubectl-delete', 'kubectl-manifest-create', 'manifest-apply-https']) {
    const code = await file(`src/service/adapters/${path}.ts`);
    assert.match(code, /config\.transportRead\([^;\n]+signal, (?:request|input)\.target\)/, path);
  }
  const read = await file('src/service/adapters/kubectl-read.ts'), once = await file('src/service/adapters/https-once.ts');
  assert.ok(read.includes('result.status === 401') && read.includes('config.credentialsRejected('));
  assert.ok(once.includes('if (status === 401) connection.credentialsRejected?.()'));
  assert.equal((read.match(/await readThroughWorker\(/g) ?? []).length, 1);
  assert.equal((once.match(/httpsRequest\(url/g) ?? []).length, 1);
});
test('manual authentication UI, bridge method and HTTP endpoint are removed; authentication executors remain forbidden to automatic functional tests', async () => {
  const panel = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts'), http = await file('src/service/runtime/http.ts');
  assert.ok(!panel.includes('mountAuthenticationView') && !bridge.includes('authenticateCurrentContext'));
  assert.ok(!http.includes('/v2/operations/authentication'));
  const check = await file('scripts/check-static.ts');
  assert.ok(check.includes("resolved === 'src/service/adapters/automatic-credentials.ts'"));
  assert.ok(check.includes("path === 'src/service/adapters/automatic-credentials.ts'"));
  assert.ok(check.includes('|exec-credential|apply-file-https|image-run-cli'));
  const readonly = await file('tests/readonly/exec-credential-values.test.ts');
  assert.ok(!/from ['"].*adapters|from ['"].*operations/.test(readonly));
});
