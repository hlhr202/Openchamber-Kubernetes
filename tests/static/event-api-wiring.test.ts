// Text-only audit of version paths and host/CLI wiring. Never imports or starts real adapters/SDK.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string)=>readFile(new URL(`../../${path}`,import.meta.url),'utf8');
test('new events v1 fixed Go source is retained and the collector refuses to drop old audited text',async()=>{
  const collector=await file('scripts/collect-query-contract.ts'),source=await file('tests/fixtures/contracts/query-contract/kubernetes/api/events/v1/types.go.txt');
  assert.ok(collector.includes("'events/v1/types.go'")&&collector.includes('Existing pinned source omitted from collection')&&collector.includes("evidence: 'M1-E049'"));
  for(const name of ['json:"regarding,omitempty"','json:"note,omitempty"','json:"deprecatedCount,omitempty"','json:"reportingController,omitempty"'])assert.ok(source.includes(name));
});
test('initial event API fallback is fixed to one reviewed alternate and only a missing collection, never auth/throttle/410/parse or continuation',async()=>{
  const code=await file('src/service/queries/resource-reader.ts');const start=code.indexOf('async events(target:'),end=code.indexOf('async logContainers(',start),part=code.slice(start,end);
  assert.ok(part.includes("previous?.apiVersion ?? 'v1'")&&part.includes("error.code !== 'NOT_FOUND'")&&part.includes("apiVersion = 'events.k8s.io/v1'")&&part.includes('projectEventPage(value, namespace, previous, apiVersion)'));
  assert.ok(!/setTimeout|delay\(|for \(|while \(|v1beta1|auth-provider|exec\(/.test(part));
});
test('cursor and client bind API version with original namespace, list RV and continuation',async()=>{
  const reader=await file('src/service/queries/events.ts'),client=await file('src/host/event-client.ts');
  assert.ok(reader.includes('apiVersion: eventApiVersionSchema')&&reader.includes('result.apiVersion !== previous.apiVersion')&&reader.includes('apiVersion: result.apiVersion'));
  assert.ok(client.includes('page.apiVersion !== previous?.apiVersion'));
});
test('grouped projection explicitly maps only reviewed fields rather than spreading raw Event extensions',async()=>{
  const code=await file('src/service/queries/event-source.ts');
  assert.ok(code.includes('message: value.note')&&code.includes('involvedObject: value.regarding ?? {}')&&code.includes('count: value.deprecatedCount')&&code.includes('reportingComponent: value.reportingController'));
  assert.ok(!/\.\.\.input|\.\.\.value|console\.|writeFile|storage\./.test(code));
});
test('Follow source, page list, watch decoder and bridge all preserve required API without silent defaults',async()=>{
  const protocol=await file('src/shared/event-follow-protocol.ts'),bridge=await file('src/host/bridge.ts'),runner=await file('src/service/queries/event-follow-runner.ts'),gateway=await file('src/service/queries/resource-gateway.ts');
  assert.ok(protocol.includes('apiVersion: eventApiVersionSchema')&&!protocol.includes("default('v1')"));assert.ok(bridge.includes('apiVersion: page.apiVersion'));
  assert.ok(runner.includes('result.apiVersion !== source.apiVersion')&&runner.includes('source.namespace.name, source.apiVersion'));
  assert.ok(gateway.includes('signal, budget, source.apiVersion, previous'));
});
test('event worker/list/watch argv expansion remains a two-API whitelist, bounded raw GET only',async()=>{
  const code=await file('src/service/queries/kubectl-plan.ts');assert.ok(code.includes("parts[1] === 'events.k8s.io' && parts[2] === 'v1'")&&code.includes('if (!eventApi || remaining.length !== 3'));
  assert.ok(!code.includes('events.k8s.io/v1beta1'));
});
test('event UI discloses actual selected API and preserves inert text without inventing a terminal destination',async()=>{
  const finite=await file('src/panel/event-view.ts'),follow=await file('src/panel/event-follow-view.ts');assert.ok(finite.includes("page.apiVersion === 'v1' ? 'core/v1' : page.apiVersion")&&follow.includes('state.page.source.namespace.name'));
  assert.ok(finite.includes('cell.textContent = logDisplayText(text)')&&follow.includes('td.textContent = logDisplayText(text)')&&!/innerHTML|new Terminal|window\.open/.test(finite+follow));
});
test('new automatic API tests are explicit pure read/protocol allowlist members, not SDK/auth/cache/CLI or write/session controls',async()=>{
  const code=await file('tests/readonly/event-api.test.ts'),list=await file('scripts/readonly-tests.ts');assert.ok(list.includes("'tests/readonly/event-api.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|runtime\/|operations\/|sessions\/|bridge|@openchamber)|spawn\(|fork\(|runReadWorker\(/.test(code));
});
