// Source-only review. Never import/execute real worker, SDK bridge, auth/cache or any operation/session.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (code: string, ...parts: string[]) => { let previous = -1; for (const part of parts) { const next = code.indexOf(part, previous + 1); assert.ok(next > previous, part); previous = next; } };
test('watch routes authenticate before handling bounded JSON and do not use an unbounded SDK response', async () => {
  const code = await file('src/service/runtime/http.ts'); ordered(code, 'authorized(request.headers.authorization', "'/v2/watch/open', '/v2/watch/poll', '/v2/watch/release'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.resources.openWatch(input, controller.signal)');
});
test('watch runtime uses only fixed read worker adapter with static-auth rejection and no implicit terminal', async () => {
  const code = await file('src/service/adapters/kubectl-watch.ts'), runtime = await file('src/service/runtime/main.ts');
  ordered(code, 'validateKubectlReadRequest(request)', 'config.transportRead(', 'privateKubectlConfiguration(', 'readThroughWorker(', 'requireReadSuccess(result.status)');
  assert.ok(runtime.includes('watch: createKubectlWatchAdapter(config, environment.path, new URL(import.meta.url))'));
  assert.ok(!/operations\/|sessions\/|shell: true|exec\(|writeFile|process\.env/.test(code));
});
test('worker watch stdout uses one acknowledged chunk at a time and waits delivery before final close result', async () => {
  const code = await file('src/service/adapters/read-worker.ts');
  ordered(code, 'child.stdout.pause()', 'await stream(bytes.subarray(offset, offset + 16_384))', 'child.stdout.resume()');
  assert.ok(code.includes("child.once('close', code => { void delivery.then(") && code.includes("start.request.purpose === 'job-pod-watch' ? sendChunk : undefined"));
  assert.ok(code.includes('parsed.data.sequence !== ack.sequence') && code.includes("kind: 'watch-chunk'") && code.includes('await new Promise<void>((resolve, reject)'));
});
test('parent validates purpose/sequence/total bytes, awaits consumer then sends ACK; cancellation only TERM supervisor', async () => {
  const code = await file('src/service/adapters/read-worker-client.ts');
  assert.ok(code.includes("start.request.purpose === 'job-pod-watch') !== !!onChunk") && code.includes('chunk.data.sequence !== ++sequence') && code.includes('chunk.data.body.byteLength) > 2_000_000'));
  ordered(code, 'void onChunk(chunk.data.body).then(', "kind: 'watch-ack'");
  assert.ok(code.includes("worker.kill('SIGTERM')") && !code.includes("worker.kill('SIGKILL')"));
});
test('read task leases/epochs/capabilities are separate from host authentication and remain charged until actual settlement', async () => {
  const code = await file('src/service/queries/read-tasks.ts');
  assert.ok(code.includes('timingSafeEqual(') && code.includes("randomBytes(32).toString('hex')") && code.includes('identity.epoch < previous.epoch'));
  assert.ok(code.includes('filter(task => !task.settled).length >= 2') && code.includes('task.consumers.size') && code.includes('consumer.leaseUntil <= now') && code.includes('task.expiresAt <= now'));
  assert.ok(code.includes('task.bytes > 65_536') && code.includes('task.events.length > 128') && !/from ['"].*(?:operations\/|sessions\/|adapters\/)/.test(code));
});
test('raw Watch parser projects only exact GVK metadata and enforces logical frame/stream budgets without content persistence', async () => {
  const code = await file('src/service/queries/watch-source.ts');
  assert.ok(code.includes('262_144') && code.includes('2_000_000') && code.includes("new TextDecoder('utf-8', { fatal: true })"));
  assert.ok(code.includes('source.object.uid !== meta.uid') && code.includes("return { type: event.type, resourceVersion: meta.resourceVersion, name: meta.name, uid: meta.uid }"));
  assert.ok(!/writeFile|storage\.|innerHTML|fetch\(|spawn\(/.test(code));
});
test('normal watch windows are bounded; only one 410 can relist and authentication errors are never retried', async () => {
  const code = await file('src/service/queries/watch-runner.ts'); assert.ok(code.includes('window < 10') && code.includes('delay(250') && code.includes('budget.bytes += chunk.byteLength) > 8_000_000'));
  ordered(code, 'await options.verify(source, signal); decoder.push(chunk)', 'await options.verify(source, signal); decoder.finish()');
  assert.ok(!/planResourceList|reader\.list|setInterval|operations\/|sessions\//.test(code));
});
test('watch UI is explicit diagnostics; target/project/dispose drops reads and only marks the matching resource page stale', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), client = await file('src/host/resource-client.ts');
  assert.ok(bridge.includes('resources.invalidate(state.page.source.resource, state.page.source.target)') && bridge.includes('watches.dispose()') && bridge.includes('watches.reset(); sourcePicker.reset()'));
  assert.ok(panel.includes('bridge?.startWatch(page.resource, page.resourceVersion)') && panel.includes('watch.dispose(); watches.dispose()'));
  assert.ok(client.includes('!sameTarget(this.#page.target, target)') && client.includes("this.#show({ phase: 'ready', stale: true, page: this.#page })"));
});
test('fixed raw GET and ListOptions sources support streaming Watch without discovery printer/cache', async () => {
  const raw = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/rawhttp/raw.go.txt'), types = await file('tests/fixtures/contracts/query-contract/kubernetes/apimachinery/pkg/apis/meta/v1/types.go.txt');
  assert.ok(raw.includes('io.Copy(') && !raw.includes('ToDiscoveryClient(')); assert.ok(types.includes('Watch bool') && types.includes('TimeoutSeconds *int64') && types.includes('AllowWatchBookmarks bool'));
});
test('watch automatic tests are explicit read-only tasks/bytes and cannot import real lifecycle or write executors', async () => {
  const code = await file('tests/readonly/watch.test.ts'), allowlist = await file('scripts/readonly-tests.ts'); assert.ok(allowlist.includes("'tests/readonly/watch.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|sessions\/|runtime\/|bridge)/.test(code) && !/spawn\(|fork\(|runReadWorker\(|readThroughWorker\(/.test(code));
});
