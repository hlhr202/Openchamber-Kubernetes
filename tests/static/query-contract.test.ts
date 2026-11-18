import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import { verifyBrowserEnvironment } from '../../scripts/check-static.ts';

const root = new URL('../../', import.meta.url);
const source = (repo: string, path: string) => readFile(new URL(`tests/fixtures/contracts/query-contract/${repo}/${path}.txt`, root), 'utf8');

test('historical CLI reference and platform checksums agree independently of runtime version admission', async () => {
  const kubectlVersion = 'v1.37.0'; // Pinned source evidence, not an executable version requirement.
  const value = z.object({ schemaVersion: z.literal(1), evidence: z.literal('M1-E014'), checkedAt: z.string(), candidateKubectlVersion: z.literal(kubectlVersion),
    scope: z.string(), runtime: z.literal('not-executed'), artifactsDownloaded: z.literal(false), toolsInstalled: z.literal(false),
    releaseChecksums: z.array(z.object({ platform: z.enum(['linux/amd64', 'darwin/arm64']), url: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).length(2),
  }).strict().parse(JSON.parse(await readFile(new URL('docs/baseline/cli-contract.json', root), 'utf8')) as unknown);
  assert.equal(new Set(value.releaseChecksums.map(item => item.platform)).size, 2);
  for (const item of value.releaseChecksums) assert.equal(item.url, `https://dl.k8s.io/release/${kubectlVersion}/bin/${item.platform}/kubectl.sha256`);
});

test('read and write workers share a client-probe validator with no pinned or minimum kubectl version', async () => {
  const plan = await readFile(new URL('src/service/queries/kubectl-plan.ts', root), 'utf8');
  const probe = plan.slice(plan.indexOf('export function verifyKubectlVersion('), plan.indexOf('export function isolatedKubectlEnvironment('));
  assert.ok(probe.includes('gitVersion: z.string()') && probe.includes('containsControlCharacters'));
  assert.ok(!/z\.literal|kubectlVersion|semver|parseInt|parseFloat|major|minor/.test(probe));
  for (const name of ['read-worker', 'delete-worker', 'manifest-create-worker']) {
    const worker = await readFile(new URL(`src/service/adapters/${name}.ts`, root), 'utf8');
    assert.ok(worker.includes('verifyKubectlVersion('), name);
    assert.ok(worker.includes("'version', '--client', '--output=json'"), name);
    assert.ok(worker.includes("version.code !== 0) throw new BoundaryError('CLI_INCOMPATIBLE')"), name);
  }
  const panel = await readFile(new URL('src/panel/main.ts', root), 'utf8');
  assert.ok(!panel.includes('kubectl v1.37.0'));
  assert.ok(panel.includes('No minimum or exact kubectl version is enforced'));
});

test('raw item TypeMeta inheritance is limited to validated typed lists, never standalone GET or Watch events', async () => {
  const file = (path: string) => readFile(new URL(`src/service/queries/${path}.ts`, root), 'utf8');
  const helper = await file('list-item');
  assert.ok(helper.includes('apiVersion: boundedName.optional()') && helper.includes('kind: boundedName.optional()'));
  assert.ok(helper.includes('parsed.data.apiVersion !== apiVersion') && helper.includes('parsed.data.kind !== kind'));
  const resources = await file('resource-query'), definitions = await file('custom-resources'), relist = await file('watch-relist');
  assert.ok(resources.indexOf('if (page.apiVersion !== version') < resources.indexOf('normalizeListItemType(item, version, type.kind)'));
  assert.ok(definitions.indexOf('definitionPageSchema.safeParse(input)') < definitions.indexOf("normalizeListItemType(item, page.apiVersion, 'CustomResourceDefinition')"));
  assert.ok(relist.indexOf('parsed.data.kind !==') < relist.indexOf('normalizeListItemType(item, parsed.data.apiVersion, type.kind)'));
  for (const path of ['parent-resource', 'watch-source', 'resource-document']) assert.ok(!(await file(path)).includes('normalizeListItemType'), path);
});

test('all thirty-seven query/inspection/write contract texts have exact commits and independent hashes, not a runtime result', async () => {
  const index = z.object({ schemaVersion: z.literal(1), evidence: z.literal('M1-E049'), records: z.array(z.object({
    repo: z.enum(['kubernetes/client-go', 'kubernetes/kubectl', 'kubernetes/cli-runtime', 'kubernetes/apiextensions-apiserver', 'kubernetes/api', 'kubernetes/apimachinery', 'peterbourgon/diskv']), tag: z.enum(['v0.37.0', 'v2.0.1']),
    commit: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().regex(/^(?:[\w/.-]+\.go|go\.mod)$/), url: z.string(), bytes: z.number().int(), sha256: z.string(),
  }).strict().refine(value => value.tag === (value.repo === 'peterbourgon/diskv' ? 'v2.0.1' : 'v0.37.0'))).length(37) }).strict().parse(JSON.parse(await readFile(new URL('docs/baseline/query-sources.json', root), 'utf8')) as unknown);
  const seen = new Set<string>();
  for (const item of index.records) {
    assert.ok(!item.path.split('/').includes('..'));
    const key = `${item.repo}/${item.path}`; assert.ok(!seen.has(key)); seen.add(key);
    const text = await source(item.repo, item.path);
    assert.equal(Buffer.byteLength(text), item.bytes);
    assert.equal(createHash('sha256').update(text).digest('hex'), item.sha256);
    assert.equal(item.url, `https://raw.githubusercontent.com/${item.repo}/${item.commit}/${item.path}`);
  }
});

test('isolated static-auth adapter preserves fixed startup/caching contracts and has no automatic process entry', async () => {
  const cmd = await source('kubernetes/kubectl', 'pkg/cmd/cmd.go');
  assert.ok(cmd.includes('genericclioptions.NewConfigFlags(true)'));
  assert.ok(cmd.includes('pref.Apply(cmds, kubeConfigFlags'));
  const preferences = await source('kubernetes/kubectl', 'pkg/kuberc/kuberc.go');
  assert.match(preferences, /os.Getenv\("KUBERC"\); val == "off"/);
  const builder = await source('kubernetes/client-go', 'tools/clientcmd/merged_client_builder.go');
  const existing = builder.indexOf('if config.clientConfig != nil'), load = builder.indexOf('config.loader.Load()');
  assert.ok(existing >= 0 && load > existing);
  const profiling = await source('kubernetes/kubectl', 'pkg/cmd/profiling.go');
  assert.match(profiling, /case "none":\s+return nil, nil/);
  const adapter = await readFile(new URL('src/service/adapters/kubectl-read.ts', root), 'utf8');
  assert.ok(!adapter.includes('process.env') && !adapter.includes('writeFile') && !adapter.includes('spawn('));
  assert.ok(adapter.indexOf('privateKubectlConfiguration(configuration.merged') < adapter.indexOf('await readThroughWorker('));
  const worker = await readFile(new URL('src/service/adapters/read-worker.ts', root), 'utf8');
  assert.ok(worker.includes('env: isolatedKubectlEnvironment(home, path)') && worker.includes('shell: false, detached: true'));
  assert.ok(worker.includes('await rmdir(home)') && worker.includes('process.kill(-child.pid, name)'));
  assert.ok(worker.indexOf('validateKubectlSnapshot(snapshot, start.request.target)') < worker.indexOf('await mkdtemp('));
  const main = await readFile(new URL('src/service/runtime/main.ts', root), 'utf8');
  assert.ok(main.includes('createKubectlReadAdapter(config, environment.path, new URL(import.meta.url))'));
  const http = await readFile(new URL('src/service/runtime/http.ts', root), 'utf8');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("['/v2/resources/read', '/v2/tree/read', '/v2/keys/read', '/v2/logs/read', '/v2/events/read', '/v2/documents/read']"));
  assert.ok(http.includes('options.resources.read(body, controller.signal)') && http.includes('options.resources.readTree(body, controller.signal)'));
});

test('same-bundle read worker has independent disconnect/deadline cleanup and FIFO transport, never a general command API', async () => {
  const worker = await readFile(new URL('src/service/adapters/read-worker.ts', root), 'utf8');
  const client = await readFile(new URL('src/service/adapters/read-worker-client.ts', root), 'utf8');
  const main = await readFile(new URL('src/service/runtime/main.ts', root), 'utf8');
  assert.ok(worker.includes("process.on('disconnect', disconnect)") && worker.includes('readWorkerDeadlineMs)'));
  assert.ok(worker.includes("command('/usr/bin/mkfifo', ['-m', '600', fifo]"));
  assert.ok(worker.includes('constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW'));
  assert.ok(worker.includes('current.isFIFO() && current.ino === owned.ino && current.dev === owned.dev'));
  assert.ok(worker.includes('kubectlReadArguments(start.request, fifo)') && worker.includes("stdio: ['ignore', 'pipe', 'pipe']"));
  assert.ok(worker.includes('Promise.allSettled([reading, writing])') && !worker.includes('writeFile'));
  assert.ok(client.includes("execPath: process.execPath, execArgv: [], detached: true"));
  assert.ok(client.includes("serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc']"));
  assert.ok(!client.includes('process.env') && !client.includes("worker.kill('SIGKILL')") && !client.includes('.unref('));
  assert.ok(main.indexOf('await runReadWorker()') < main.indexOf('const port = process.env.OPENCHAMBER_SERVICE_PORT'));
  const protocol = await readFile(new URL('src/service/queries/read-worker-protocol.ts', root), 'utf8');
  assert.ok(protocol.includes('validateKubectlReadRequest(parsed.data.request)') && protocol.includes('readWorkerDeadlineMs = 8000'));
});

test('metadata-negotiated collection transport is GET-only, budgeted and never falls back after dispatch', async () => {
  const file = (name: string) => readFile(new URL(name, root), 'utf8');
  const adapter = await file('src/service/adapters/kubectl-read.ts'), transport = await file('src/service/adapters/metadata-list-https.ts');
  const planner = await file('src/service/queries/resource-list-representation.ts'), guard = await file('scripts/check-static.ts');
  assert.ok(adapter.indexOf('validateResourceReadTransportRequest(request)') < adapter.indexOf('config.transportRead('));
  assert.ok(adapter.indexOf('await tryMetadataList(request, input, signal)') < adapter.indexOf('await readThroughWorker('));
  assert.equal(transport.match(/httpsRequest\(url/g)?.length, 1);
  assert.match(transport, /method: 'GET', agent: false, rejectUnauthorized: true/);
  assert.match(transport, /status !== 200[\s\S]+response\.destroy\(\); return/);
  assert.ok(transport.includes('total > request.maximumBytes') && transport.includes('response.complete') && transport.includes("client.once('close'"));
  assert.ok(!/readThroughWorker|writeFile|redirect\(|fetch\(/.test(transport));
  assert.ok(planner.includes("request.purpose !== 'resource-list'") && guard.includes("path === 'src/service/adapters/metadata-list-https.ts'"));
});

test('read worker transport evidence is pinned public text, with Node socket stdio and POSIX FIFO semantics, not a runtime result', async () => {
  const index = z.object({ schemaVersion: z.literal(1), evidence: z.literal('M1-E016'), checkedAt: z.string(), runtime: z.literal('not-executed'),
    records: z.array(z.object({ id: z.string().regex(/^[a-z0-9.-]+$/), url: z.string().startsWith('https://'), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).length(3),
  }).strict().parse(JSON.parse(await readFile(new URL('docs/baseline/read-runtime-sources.json', root), 'utf8')) as unknown);
  assert.equal(new Set(index.records.map(item => item.id)).size, 3);
  for (const item of index.records) {
    const bytes = await readFile(new URL(`tests/fixtures/contracts/read-runtime-contract/${item.id}.txt`, root));
    assert.equal(bytes.byteLength, item.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
  const node = await readFile(new URL('tests/fixtures/contracts/read-runtime-contract/node-24.22.1-child-process.txt', root), 'utf8');
  assert.ok(node.includes('not actual Unix pipes') && node.includes('execArgv') && node.includes('advanced'));
  const host = await readFile(new URL('tests/fixtures/baseline/openchamber/packages/web/server/lib/guests/service.js.txt', root), 'utf8');
  assert.ok(host.includes("ELECTRON_RUN_AS_NODE: '1'") && host.includes('spawn(process.execPath, [absoluteEntry]'));
});

test('branch route shares the existing bounded gateway/reader and SDK explicit diagnostic controls, not a second process pool or arbitrary executor', async () => {
  const gateway = await readFile(new URL('src/service/queries/resource-gateway.ts', root), 'utf8');
  assert.equal(gateway.match(/createResourceReader\(/g)?.length, 1);
  assert.equal(gateway.match(/new ReadScheduler/g)?.length, 1);
  assert.ok(gateway.includes('createBranchReader(reader, pager)') && gateway.includes('branches.dispose(); pager.dispose(); reader.close()'));
  const http = await readFile(new URL('src/service/runtime/http.ts', root), 'utf8');
  assert.ok(http.includes('boundedBody(request, controller.signal, resourceRequestBytes)') && http.includes('options.resources.readTree(body, controller.signal)'));
  const bridge = await readFile(new URL('src/host/bridge.ts', root), 'utf8');
  assert.ok(bridge.includes('new BranchClient(request => host.serviceRequest(request)') && bridge.includes('branches.dispose()'));
  const panel = await readFile(new URL('src/panel/branch-diagnostics.ts', root), 'utf8');
  assert.ok(panel.includes('parentFromResource(node)') && panel.includes('node.definition') && panel.includes('label.textContent = node.label'));
  assert.ok(!panel.includes('innerHTML') && !panel.includes('fetch('));
});

test('headless tree is wired to the same SDK and configuration generations without enabling unmeasured DOM or business actions', async () => {
  const bridge = await readFile(new URL('src/host/bridge.ts', root), 'utf8');
  assert.ok(bridge.includes('new TreeController(request => host.serviceRequest(request), snapshot => showTree?.(snapshot))'));
  assert.ok(bridge.includes('tree.configure(state.config, client.selection') && bridge.includes('tree.suspend(state.error)') && bridge.includes('tree.dispose()'));
  const source = await readFile(new URL('src/host/tree-source.ts', root), 'utf8');
  assert.ok(source.includes('validateResourceReadPage(') && source.includes('validateBranchReadPage('));
  const model = await readFile(new URL('src/shared/tree-model.ts', root), 'utf8');
  assert.ok(!model.includes('document.') && !model.includes('localStorage') && !model.includes('fetch('));
  const controller = await readFile(new URL('src/host/tree-controller.ts', root), 'utf8');
  assert.ok(controller.includes('this.#inflight.size >= 8') && controller.includes('this.#inflight.delete(controller)'));
  assert.ok(!controller.includes('storageSet') && !controller.includes('service/adapters'));
});

test('explicit sensitive key route is authenticated, shares the read pool and renders only text with lifecycle clearing', async () => {
  const source = (path: string) => readFile(new URL(path, root), 'utf8');
  const http = await source('src/service/runtime/http.ts'), gateway = await source('src/service/queries/resource-gateway.ts');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("'/v2/keys/read'"));
  assert.ok(http.includes('options.resources.readKey(body, controller.signal)'));
  assert.ok(gateway.includes('createKeyContentReader(reader)') && gateway.includes('keyContents.dispose()'));
  assert.equal(gateway.match(/createResourceReader\(/g)?.length, 1);
  const bridge = await source('src/host/bridge.ts'), view = await source('src/panel/key-content-view.ts');
  assert.ok(bridge.includes('new KeyContentClient(request => host.serviceRequest(request), showKeyContent)'));
  assert.ok(bridge.includes("if (state.phase !== 'ready') { jobSelections.reset(); resources.reset(); branches.reset(); keyContent.reset(); podLogs.reset(); events.reset(); deletes.reset(); documents.suspend(); }"));
  assert.ok(bridge.includes('keyContent.dispose()') && bridge.includes('documents.reset(); projectChanged()'));
  assert.ok(view.includes('pre.textContent = state.text') && view.includes("pre.textContent = ''"));
  const panel = await source('src/panel/branch-diagnostics.ts');
  assert.ok(panel.includes('keyReferenceFromNode(node)') && panel.includes('readKeyContent(reference)'));
  for (const path of ['src/shared/key-content-protocol.ts', 'src/host/key-content-client.ts', 'src/panel/key-content-view.ts', 'src/service/queries/key-content.ts', 'src/service/queries/configuration-value.ts']) {
    const text = await source(path);
    assert.ok(!/innerHTML|localStorage|sessionStorage|storageSet|clipboard\.write|console\.|sendMessage\(|confirm\(/.test(text), path);
    assert.ok(!/from ['"][^'"]*(?:operations|sessions|adapters)\//.test(text), path);
  }
});

test('browser isolation parses actual builtin literals and process env access, not ordinary node object keys or text', () => {
  for (const code of ['const entry = {node: {label: "Pod"}};', 'const text = "node: label, process.env is unavailable";', 'const entry = {process: "label", env: "value"};']) assert.doesNotThrow(() => verifyBrowserEnvironment(code));
  for (const code of ['const builtin = "node:fs";', 'const env = process.env;', 'const env = process["env"];', 'const env = globalThis.process.env;', 'const env = window["process"]["env"];']) assert.throws(() => verifyBrowserEnvironment(code));
});

test('finite Pod log route and controls consume pinned GET/PodLogOptions facts without sessions or implicit writes', async () => {
  const api = await source('kubernetes/api', 'core/v1/types.go');
  assert.ok(api.includes('type PodLogOptions struct') && api.includes('Follow the log stream of the pod. Defaults to false.'));
  assert.ok(api.includes('json:"sinceSeconds,omitempty"') && api.includes('json:"tailLines,omitempty"') && api.includes('slightly more or slightly less than the specified limit'));
  const client = await source('kubernetes/client-go', 'kubernetes/typed/core/v1/pod_expansion.go');
  assert.ok(client.includes('SubResource("log")') && client.includes('c.GetClient().Get()'));
  const file = (path: string) => readFile(new URL(path, root), 'utf8');
  const http = await file('src/service/runtime/http.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("'/v2/logs/read'"));
  assert.ok(http.includes('options.resources.readLogs(body, controller.signal)') && gateway.includes('createPodLogReader(reader)') && gateway.includes('podLogs.dispose()'));
  const bridge = await file('src/host/bridge.ts'); assert.ok(bridge.includes('new PodLogClient(request => host.serviceRequest(request), state =>') && bridge.includes('showPodLogs(state)'));
  const panel = await file('src/panel/pod-log-view.ts'); assert.ok(panel.includes('viewer.show(state.text,') && panel.includes('viewer.dispose()'));
  for (const path of ['src/service/queries/pod-logs.ts', 'src/service/queries/pod-log-source.ts', 'src/shared/pod-log-protocol.ts', 'src/host/pod-log-client.ts', 'src/panel/pod-log-view.ts']) {
    const text = await file(path);
    assert.ok(!/innerHTML|localStorage|sessionStorage|storageSet|console\.|clipboard\.write|sendMessage\(/.test(text), path);
    assert.ok(!/from ['"][^'"]*(?:operations|sessions|adapters)\//.test(text), path);
  }
});

test('Job log provenance consumes upstream selector resolution but never pretends an implicit first Pod is an explicit user choice', async () => {
  const helper = await source('kubernetes/kubectl', 'pkg/polymorphichelpers/helpers.go');
  assert.ok(helper.includes('case *batchv1.Job:') && helper.includes('metav1.LabelSelectorAsSelector(t.Spec.Selector)'));
  assert.ok(helper.includes('LabelSelector: selector') && helper.includes('client.Pods(namespace).Watch('));
  const upstream = await source('kubernetes/kubectl', 'pkg/polymorphichelpers/logsforobject.go');
  assert.ok(upstream.includes('podutils.ByLogging(pods)') && upstream.includes('GetFirstPod(clientset, namespace, selector.String()'));
  const file = (path: string) => readFile(new URL(path, root), 'utf8');
  const reader = await file('src/service/queries/resource-reader.ts'), client = await file('src/host/pod-log-client.ts');
  assert.ok(reader.includes('jobLogMembership(beforeJob, beforePod') && reader.includes('jobLogMembership(afterJob, afterPod'));
  assert.ok(client.includes('jobLogOriginId(result.origin) !== jobLogOriginId(request.origin)'));
  const panel = await file('src/panel/branch-diagnostics.ts');
  assert.ok(panel.includes('jobLogOriginFromParent(state.page.parent)') && panel.includes('openPodLog(reference, origin ?? undefined)'));
  assert.ok((await file('src/panel/main.ts')).includes('Select Job log Pod'));
  const store = await file('src/service/queries/pod-logs.ts'); assert.ok(store.includes('request.options, signal, request.origin') && store.includes('request.container, signal, request.origin'));
  const projection = await file('src/service/queries/job-log-source.ts');
  assert.ok(!/from ['"][^'"]*(?:operations|sessions|adapters)\//.test(projection) && !/console\.|writeFile|spawn\(/.test(projection));
});

test('finite Namespace Events consumes pinned core Event/series and audited upstream scope without creating Watch, PTY or persistent output', async () => {
  const api = await source('kubernetes/api', 'core/v1/types.go');
  assert.ok(api.includes('type Event struct') && api.includes('type EventSeries struct') && api.includes('treated as informative, best-effort, supplemental data'));
  for (const field of ['firstTimestamp', 'lastTimestamp', 'eventTime', 'series', 'lastObservedTime']) assert.ok(api.includes(`json:"${field},omitempty"`));
  const upstream = await readFile(new URL('tests/fixtures/baseline/kubernetes/src/components/kubectl/events.ts.txt', root), 'utf8');
  assert.ok(upstream.includes('eventsNS = explorerNode.name') && upstream.includes('kubectlUtils.currentNamespace(kubectl)') && upstream.includes('get events --namespace'));
  const file = (path: string) => readFile(new URL(path, root), 'utf8');
  const http = await file('src/service/runtime/http.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("'/v2/events/read'"));
  assert.ok(http.includes('options.resources.readEvents(body, controller.signal)') && gateway.includes('createEventReader(reader)') && gateway.includes('events.dispose()'));
  assert.equal(gateway.match(/createResourceReader\(/g)?.length, 1); assert.equal(gateway.match(/new ReadScheduler/g)?.length, 1);
  const reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(reader.includes("'namespace-events', randomUUID()") && reader.includes('projectEventNamespace(await get(`/api/v1/namespaces/${name}`), name, namespace)'));
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts');
  assert.ok(bridge.includes('new EventClient(request => host.serviceRequest(request), state =>') && bridge.includes('showEvents(state)') && bridge.includes('documents.reset(); projectChanged()') && bridge.includes('events.dispose()'));
  assert.ok(panel.includes('eventScopeFromNode(node)') && panel.includes('readEvents(scope)') && panel.includes('bridge?.readEvents()'));
  assert.ok((await file('src/panel/event-view.ts')).includes('cell.textContent = logDisplayText(text)'));
  for (const path of ['src/shared/event-protocol.ts', 'src/service/queries/event-source.ts', 'src/service/queries/events.ts', 'src/host/event-client.ts', 'src/panel/event-view.ts']) {
    const text = await file(path);
    assert.ok(!/innerHTML|localStorage|sessionStorage|storageSet|console\.|clipboard\.write|sendMessage\(|spawn\(|writeFile/.test(text), path);
    assert.ok(!/from ['"][^'"]*(?:operations|sessions|adapters)\//.test(text), path);
  }
});

test('named Load uses pinned managedFields omission and the existing authenticated raw GET transport, with content only in explicit chunks', async () => {
  const flags = await source('kubernetes/cli-runtime', 'pkg/genericclioptions/json_yaml_flags.go');
  const fields = await source('kubernetes/cli-runtime', 'pkg/printers/managedfields.go');
  assert.ok(flags.includes('if !f.ShowManagedFields') && flags.includes('printers.OmitManagedFieldsPrinter'));
  assert.ok(fields.includes('a.SetManagedFields(nil)') && fields.includes('obj.DeepCopyObject()'));
  const file = (path: string) => readFile(new URL(path, root), 'utf8');
  const http = await file('src/service/runtime/http.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("'/v2/documents/read'"));
  assert.ok(http.includes('options.resources.readDocument(body, controller.signal)') && gateway.includes('createDocumentReader(reader)') && gateway.includes('documents.dispose()'));
  assert.equal(gateway.match(/createResourceReader\(/g)?.length, 1);
  const reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(reader.includes("key(target, 'document', randomUUID())") && reader.includes('projectResourceDocument(text, plan.reference, format)'));
  const bridge = await file('src/host/bridge.ts'); assert.ok(bridge.includes('new DocumentClient(request => host.serviceRequest(request), state =>') && bridge.includes('documentState = state; fileSaves?.changed(); manifestDiff?.changed(); explanations.reset(); showDocument(state)') && bridge.includes('documents.reset(); projectChanged()'));
  assert.ok((await file('src/panel/main.ts')).includes('readDocument(documentReference, format)'));
  assert.ok((await file('src/panel/branch-diagnostics.ts')).includes('readDocument(loadReference, format)'));
  for (const path of ['src/shared/document-protocol.ts', 'src/shared/document-json.ts', 'src/service/queries/documents.ts', 'src/service/queries/resource-document.ts', 'src/host/document-client.ts', 'src/panel/document-view.ts']) {
    const text = await file(path); assert.ok(!/innerHTML|localStorage|sessionStorage|storageSet|console\.|clipboard\.write|sendMessage\(|writeFile|spawn\(/.test(text), path);
    assert.ok(!/from ['"][^'"]*(?:operations|sessions|adapters)\//.test(text), path);
  }
});

test('M4 detached edit buffer is pure and guarded by complete reading/dirty intent; no buffer itself executes file-save or cluster-submit', async () => {
  const file = (path: string) => readFile(new URL(path, root), 'utf8');
  const buffer = await file('src/shared/document-buffer.ts'), client = await file('src/host/document-client.ts'), view = await file('src/panel/document-view.ts');
  assert.ok(!/fetch\(|serviceRequest|writeFile|spawn\(|from ['"]node:|from ['"][^'"]*(?:operations|sessions)\//.test(buffer));
  assert.ok(client.includes("this.#buffer?.state.dirty") && client.includes("'DOCUMENT_DIRTY'") && client.includes('page.nextCursor ? undefined : new DocumentBuffer(text, page)'));
  assert.ok(view.includes('field.update(') && view.includes('value: state.editor?.text'));
  // Explicitly labelled discard buttons, not hidden Save/Apply or a global Ctrl+S handler.
  assert.ok(view.includes('丢弃修改并重新读取') && view.includes('丢弃修改并关闭') && !/keydown|saveFile\(|applyResource\(|submitOperation\(/.test(view));
});

test('fixed source proves migration precedes explicit-path handling; raw GET avoids normal resource builder', async () => {
  const loader = await source('kubernetes/client-go', 'tools/clientcmd/loader.go');
  const start = loader.indexOf('func (rules *ClientConfigLoadingRules) Load()');
  const migrate = loader.indexOf('rules.Migrate()', start), explicit = loader.indexOf('if len(rules.ExplicitPath) > 0', start);
  assert.ok(start >= 0 && migrate > start && explicit > migrate);
  assert.ok(loader.includes('MigrationRules:   currentMigrationRules()'));
  const get = await source('kubernetes/kubectl', 'pkg/cmd/get/get.go');
  const run = get.slice(get.indexOf('func (o *GetOptions) Run('));
  assert.ok(run.indexOf('rawhttp.RawGet') < run.indexOf('f.NewBuilder()'));
  assert.ok(run.includes('f.RESTClient()'));
  const raw = await source('kubernetes/kubectl', 'pkg/rawhttp/raw.go');
  assert.match(raw, /func RawGet[^]*?return raw\([^\n]*"GET"\)/);
  const definitions = await source('kubernetes/apiextensions-apiserver', 'pkg/apis/apiextensions/v1/types.go');
  assert.ok(definitions.includes('There must be exactly one version with storage=true.'));
  assert.ok(definitions.includes('listKind is the serialized kind of the list'));
  const validation = await source('kubernetes/apiextensions-apiserver', 'pkg/apis/apiextensions/validation/validation.go');
  assert.ok(validation.includes('utilvalidation.IsDNS1035Label(version.Name)'));
});
