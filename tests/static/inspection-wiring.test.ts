// Text only. Never imports/runs workers, adapters, bridge, SDK interaction, actual cache access, auth or writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('inspection route authenticates/bounds JSON and shares the original read-only gateway and reader pools', async () => {
  const http = await file('src/service/runtime/http.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/inspection/read'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.resources.readInspection(input, controller.signal)');
  ordered(gateway.slice(gateway.indexOf('async readInspection(')), 'inspectionRequestSchema.safeParse(input)', 'requests.run(key', 'await bind(value, signal)', 'inspections.read({ ...value, target }');
  assert.ok(gateway.includes('createInspectionReader(reader)') && gateway.includes('inspections.dispose()'));
});
test('printer output is bracketed by exact UID/RV resource checks and configuration verification before projection', async () => {
  const code = await file('src/service/queries/resource-reader.ts'), inspect = code.slice(code.indexOf('async inspect('), code.indexOf('async namespaceInventory('));
  ordered(inspect, 'planResourceDocument(reference, readTarget(target))', 'scheduler.run(', 'await verify(target, sharedSignal)', 'captureInspectionReference(', "mode === 'wide' ? 'resource-wide' : 'resource-describe'", 'verifyResourceObject(', 'current.type, current)', 'await verify(target, sharedSignal)', 'project(text, current)');
});
test('printer arguments stay whitelisted with a single full TYPE/NAME, no raw/argv API, explicit events/wide and cache sentinel', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), ipc = await file('src/service/queries/read-worker-protocol.ts');
  assert.ok(plan.includes('const qualified = `${resource}.${version}.${group}/${name}`') && plan.includes("'--cache-dir=/dev/null'"));
  assert.ok(plan.includes("['--output=wide', '--server-print=true']") && plan.includes("['--show-events=true']") && plan.includes("'--chunk-size=100'"));
  assert.ok(ipc.includes("'resource-wide', 'resource-describe'") && ipc.includes('validateKubectlReadRequest(parsed.data.request)'));
});
test('worker requires a verified root-owned non-link character-device /dev/null before any CLI or temporary HOME creation', async () => {
  const worker = await file('src/service/adapters/read-worker.ts');
  ordered(worker, 'validateKubectlSnapshot(snapshot, start.request.target)', "await lstat('/dev/null', { bigint: true })", '!sink.isCharacterDevice()', 'sink.isSymbolicLink()', 'sink.uid !== 0n', "await realpath('/dev/null') !== '/dev/null'", 'home = await mkdtemp(', "await command('kubectl'");
  assert.ok(worker.includes('read.value.code === 0 ? 200 : kubectlFailureStatus') && worker.includes('status === 200 ? new Uint8Array(read.value.stdout) : new Uint8Array()'));
});
test('pinned discovery cache fails before creating cache files and uses live delegate output when the cache is unavailable', async () => {
  const cache = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/discovery/cached/disk/cached_discovery.go.txt'), config = await file('tests/fixtures/contracts/query-contract/kubernetes/cli-runtime/pkg/genericclioptions/config_flags.go.txt');
  ordered(cache.slice(cache.indexOf('func (d *CachedDiscoveryClient) writeCachedFile(')), 'os.MkdirAll(filepath.Dir(filename)', 'return err', 'runtime.Encode(', 'os.CreateTemp(filepath.Dir(filename)');
  assert.ok(cache.includes('return liveResources, nil') && config.includes('filepath.Join(cacheDir, "http")') && config.includes('filepath.Join(cacheDir, "discovery")'));
});
test('pinned HTTP cache and diskv keep base/temp descendants of the sentinel, returning mkdir errors without default temporary fallback', async () => {
  const rt = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/discovery/cached/disk/round_tripper.go.txt'), disk = await file('tests/fixtures/contracts/query-contract/peterbourgon/diskv/diskv.go.txt'), mod = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/go.mod.txt');
  assert.ok(mod.includes('github.com/peterbourgon/diskv v2.0.1+incompatible') && rt.includes('BasePath: cacheDir') && rt.includes('filepath.Join(cacheDir, ".diskv-temp")'));
  ordered(disk.slice(disk.indexOf('func (d *Diskv) createKeyFileWithLock(')), 'if d.TempDir != ""', 'os.MkdirAll(d.TempDir', 'return nil', 'ioutil.TempFile(d.TempDir');
  assert.ok(rt.includes('_ = c.disk.Write(') && !rt.includes('EraseAll('));
});
test('fixed CLI persists its in-memory loader and one-argument Describe prevents named-object NotFound prefix matching', async () => {
  const describe = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/describe/describe.go.txt'), schema = await file('tests/fixtures/contracts/query-contract/kubernetes/apimachinery/pkg/runtime/schema/group_version.go.txt');
  assert.ok(describe.includes('apierrors.IsNotFound(err) && len(o.BuilderArgs) == 2') && schema.includes('strings.Count(arg, ".") >= 2') && schema.includes('Group: s[2], Version: s[1], Resource: s[0]'));
  assert.ok((await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/cmd.go.txt')).includes('genericclioptions.NewConfigFlags(true)'));
  assert.ok((await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/merged_client_builder.go.txt')).includes('if config.clientConfig != nil'));
});
test('inspection snapshots have fixed byte/entry/TTL limits, sealed binding and metadata-only continuations without printer replay', async () => {
  const query = await file('src/service/queries/inspection-output.ts');
  assert.ok(query.includes('snapshots.size >= 16') && query.includes('retainedBytes + bytes > 4 * inspectionBytes') && query.includes('expiresAt: now() + 60_000'));
  const continuation = query.slice(query.indexOf('if (cursor)'), query.indexOf('if (snapshots.size >= 16'));
  assert.ok(continuation.includes('reader.verifyReference(') && !continuation.includes('reader.inspect('));
  assert.ok(query.includes('snapshots.clear()') && query.includes('codec.dispose()') && !/writeFile|setInterval|operations\//.test(query));
});
test('SDK bridge/view expose real named Get/Describe/refresh only as read-only text and clear old target output on lifecycle changes', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), view = await file('src/panel/inspection-view.ts'), client = await file('src/host/inspection-client.ts');
  assert.ok(bridge.includes('new InspectionClient(request => host.serviceRequest(request), showInspection)') && bridge.includes('inspections.reset()') && bridge.includes('inspections.dispose()'));
  assert.ok(panel.includes("for (const mode of ['wide', 'describe']") && view.includes('bridge()?.refreshInspection()') && view.includes('renderInspectionText(document, pre, logDisplayText(state.text))'));
  assert.ok(!/DocumentBuffer|\.prepare\(|\.submit\(|localStorage|clipboard|sendMessage|innerHTML|setInterval/.test(client + view));
});
test('new automatic inspection tests import only independent read/protocol/client helpers and cannot invoke CLI/cache/SDK or write chains', async () => {
  const code = await file('tests/readonly/inspection-output.test.ts'), allowlist = await file('scripts/readonly-tests.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|namespace-client|preference-client)/.test(code));
  assert.ok(!/runReadWorker\(|readThroughWorker\(|spawn\(|fork\(/.test(code) && allowlist.includes("'tests/readonly/inspection-output.test.ts'"));
});
