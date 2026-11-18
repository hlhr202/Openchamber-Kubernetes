// Text-only audit: no worker/cache/SDK lifecycle or write handler is imported/executed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (code: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = code.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('Explain authenticates/bounds the metadata-only request and shares original gateway/reader schedulers', async () => {
  const http = await file('src/service/runtime/http.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/explain/read'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.resources.explain(input, controller.signal)');
  ordered(gateway.slice(gateway.indexOf('async explain(')), 'explainRequestSchema.safeParse(input)', 'requests.run(key', 'await bind(value, signal)', 'reader.explain({ ...value, target }');
});
test('Explain verifies index-schema-index identity and configuration before projecting a bounded response without retaining schemas', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), code = reader.slice(reader.indexOf('async explain('), reader.indexOf('async verifyTarget('));
  ordered(code, 'await verify(target, sharedSignal)', 'const before = await index()', "request(target, 'openapi-schema'", 'projectExplanation(schema, input)', '(await index()).identity !== before.identity', 'await verify(target, sharedSignal)', 'explainResponseSchema.parse(');
  assert.ok(code.includes('> 64_000') && !/writeFile|new Map|setInterval|operations\//.test(code));
});
test('schema 8MB budget cannot broaden ordinary requests or default IPC results and parent applies the validated purpose cap', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), protocol = await file('src/service/queries/read-worker-protocol.ts'), client = await file('src/service/adapters/read-worker-client.ts');
  assert.ok(plan.includes("request.purpose === 'openapi-index' || request.purpose === 'openapi-schema'") && plan.includes('request.maximumBytes !== 8_000_000') && plan.includes('request.maximumBytes !== 2_000_000'));
  assert.ok(protocol.includes('maximumBytes = 2_000_000') && protocol.includes('parsed.data.body.byteLength > maximumBytes') && client.includes('parseReadWorkerResult(message, start.request.maximumBytes)'));
});
test('schema projection uses full GVK/local refs, bounded traversal and own-property lookup with no external resolution', async () => {
  const code = await file('src/service/queries/openapi-explanation.ts');
  assert.ok(code.includes('gvk.group === request.type.group && gvk.version === request.type.version && gvk.kind === request.type.kind') && code.includes('Object.hasOwn(value, key)'));
  assert.ok(code.includes('nodes > 200_000') && code.includes('item.depth > 64') && code.includes('steps > 512') && code.includes('seen.has(ref)'));
  assert.ok(!/fetch\(|https\.request|writeFile|eval\(|setInterval|operations\//.test(code));
});
test('local document field helper walks YAML AST without values/alias expansion and sends only original type/path/generation', async () => {
  const code = await file('src/host/document-fields.ts');
  assert.ok(code.includes('isAlias(item.node)') && code.includes('fields.length >= 2000') && code.includes('item.depth > 32'));
  const projection = code.slice(code.indexOf('return explainRequestSchema.parse('));
  assert.ok(projection.includes('fieldPath: field.path') && projection.includes('documentIdentity: state.page.contentIdentity') && !/text:|body:|content:/.test(projection));
  assert.ok(!/\.toJS\(|operations\/|adapters\/|writeFile|spawn\(/.test(code));
});
test('document lifecycle resets explanation before UI delivery and service calls originate only from explicit field selection', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/explain-view.ts');
  assert.ok(bridge.includes('documentState = state; fileSaves?.changed(); manifestDiff?.changed(); explanations.reset(); showDocument(state)') && bridge.includes('explanations.dispose()'));
  assert.ok(bridge.includes('explanationRequest(documentState, fieldId, revision)') && view.includes('enabled = false') && view.includes('bridge()?.readExplanation(selected, doc.editor.revision)'));
  assert.ok(!/setInterval|\.prepare\(|\.submit\(|clipboard|sendMessage|innerHTML|createElement\('a'\)/.test(view));
});
test('fixed client-go source exposes group-version hash locators and raw GET transport streams without discovery cache', async () => {
  const client = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/openapi/client.go.txt'), group = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/openapi/groupversion.go.txt'), raw = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/rawhttp/raw.go.txt');
  assert.ok(client.includes('AbsPath("/openapi/v3")') && client.includes('discoMap.Paths') && group.includes('g.item.ServerRelativeURL') && group.includes('locator.Query()'));
  assert.ok(raw.includes('io.Copy(') && !raw.includes('ToDiscoveryClient('));
});
test('Explain automatic tests are allowlisted and cannot import real adapters/SDK/bridge or any write handler', async () => {
  const code = await file('tests/readonly/explain.test.ts'), allowlist = await file('scripts/readonly-tests.ts');
  assert.ok(allowlist.includes("'tests/readonly/explain.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|namespace-client|preference-client)/.test(code) && !/spawn\(|fork\(|readThroughWorker\(|runReadWorker\(/.test(code));
});
