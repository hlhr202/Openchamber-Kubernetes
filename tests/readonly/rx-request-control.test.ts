// Synthetic read-only transport, controllable monotonic clock, and headless TreeController only.
// Never imports runtime, operations, sessions, write adapters, or panel tree-view.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { BoundaryError } from '../../src/shared/errors.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { TreeController } from '../../src/host/tree-controller.ts';
import { TreeRefreshQueue } from '../../src/host/tree-refresh-queue.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { createOutboundReadGate, frozenRxReadLimits } from '../../src/service/queries/outbound-read-gate.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import type { ReadResponse } from '../../src/service/queries/bounded-response.ts';

const signal = () => new AbortController().signal;
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function responseOf(value: unknown, status = 200, retryAfterMs?: number): ReadResponse {
  const text = JSON.stringify(value);
  return {
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(text);
      },
    },
    close: async () => {},
  };
}

function multiContextKubeconfig(count = 10, activeIndex = 0) {
  const clusters = Array.from({ length: count }, (_, i) => ({
    name: `cluster-${i}`,
    cluster: { server: `https://cluster-${i}.synthetic.invalid` },
  }));
  const contexts = Array.from({ length: count }, (_, i) => ({
    name: `ctx-${i}`,
    context: { cluster: `cluster-${i}`, namespace: 'default' },
  }));
  return JSON.stringify({
    'current-context': `ctx-${activeIndex}`,
    clusters,
    contexts,
  });
}

function makeHelmReleaseSecret(name: string, namespace: string, revision: number, status: string, uid: string, rv: string) {
  const payload = {
    name,
    info: { status, last_deployed: '2026-11-16T10:00:00Z' },
    chart: { metadata: { name: 'demo-chart', version: '1.2.3', appVersion: '2.0.0' } },
    version: revision,
    namespace,
  };
  const inner = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
  const encoded = Buffer.from(inner, 'utf8').toString('base64');
  return {
    type: 'helm.sh/release.v1',
    metadata: {
      name: `sh.helm.release.v1.${name}.v${revision}`,
      namespace,
      uid,
      resourceVersion: rv,
      labels: { owner: 'helm', name, status, version: String(revision) },
    },
    data: { release: encoded },
  };
}

function makeTreeGatewayFixture(options: {
  readonly contexts?: number;
  readonly kubeconfigText?: string;
  readonly outbound?: Parameters<typeof createResourceGateway>[0]['outbound'];
  readonly onRequest?: (request: ResourceReadRequest, signal: AbortSignal) => ReadResponse | Promise<ReadResponse>;
} = {}) {
  const rawConfig = options.kubeconfigText ?? multiContextKubeconfig(options.contexts ?? 10);
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: rawConfig }));
  const requests: ResourceReadRequest[] = [];
  const gateway = createResourceGateway({
    config,
    serviceGeneration: 'gen-1',
    outbound: options.outbound ?? { tokensPerSecond: 1000, burst: 32 },
    read: async (_selection, request, abortSignal) => {
      requests.push(request);
      if (options.onRequest) return options.onRequest(request, abortSignal);
      return defaultTreeReply(request);
    },
  });
  return { config, gateway, requests };
}

function defaultTreeReply(request: ResourceReadRequest): ReadResponse {
  if (request.purpose === 'resource-object') {
    if (request.path.includes('/pods/')) {
      return responseOf({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'web-0', namespace: 'default', uid: 'pod-uid-0', resourceVersion: '101' },
        status: { phase: 'Running', podIP: '10.0.0.10', containerStatuses: [{ ready: true }] },
        spec: {},
      });
    }
    if (request.path.includes('/deployments/')) {
      return responseOf({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'api', namespace: 'default', uid: 'dep-uid-1', resourceVersion: '50' },
        spec: { selector: { matchLabels: { app: 'api' } } },
      });
    }
    if (request.path.includes('/configmaps/')) {
      return responseOf({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'app-cfg', namespace: 'default', uid: 'cm-uid-1', resourceVersion: '22' },
        data: { 'config.yaml': 'port: 8080' },
      });
    }
    if (request.path.includes('/secrets/')) {
      return responseOf({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'db-secret', namespace: 'default', uid: 'sec-uid-1', resourceVersion: '33' },
        data: { password: Buffer.from('SUPER_SECRET_PASSWORD_VALUE').toString('base64') },
      });
    }
    if (request.path.includes('/nodes/')) {
      return responseOf({
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name: 'node-a', uid: 'node-uid-1', resourceVersion: '12' },
      });
    }
    if (request.path.includes('/services/')) {
      return responseOf({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'svc-empty', namespace: 'default', uid: 'svc-uid-1', resourceVersion: '14' },
        spec: { selector: {} },
      });
    }
  }
  if (request.path.endsWith('/pods')) {
    return responseOf({
      apiVersion: 'v1',
      kind: 'PodList',
      metadata: { resourceVersion: '200' },
      items: [{
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'web-0', namespace: 'default', uid: 'pod-uid-0', resourceVersion: '101' },
        status: { phase: 'Running', podIP: '10.0.0.10', containerStatuses: [{ ready: true }] },
      }],
    });
  }
  if (request.path.endsWith('/deployments')) {
    return responseOf({
      apiVersion: 'apps/v1',
      kind: 'DeploymentList',
      metadata: { resourceVersion: '201' },
      items: [{
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'api', namespace: 'default', uid: 'dep-uid-1', resourceVersion: '50' },
      }],
    });
  }
  if (request.path.endsWith('/configmaps')) {
    return responseOf({
      apiVersion: 'v1',
      kind: 'ConfigMapList',
      metadata: { resourceVersion: '202' },
      items: [{
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'app-cfg', namespace: 'default', uid: 'cm-uid-1', resourceVersion: '22' },
        data: { 'config.yaml': 'port: 8080' },
      }],
    });
  }
  if (request.path.endsWith('/secrets')) {
    return responseOf({
      apiVersion: 'v1',
      kind: 'SecretList',
      metadata: { resourceVersion: '203' },
      items: [{
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'db-secret', namespace: 'default', uid: 'sec-uid-1', resourceVersion: '33' },
        data: { password: Buffer.from('SUPER_SECRET_PASSWORD_VALUE').toString('base64') },
      }],
    });
  }
  if (request.path.endsWith('/nodes')) {
    return responseOf({
      apiVersion: 'v1',
      kind: 'NodeList',
      metadata: { resourceVersion: '204' },
      items: [{
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name: 'node-a', uid: 'node-uid-1', resourceVersion: '12' },
      }],
    });
  }
  if (request.path.endsWith('/services')) {
    return responseOf({
      apiVersion: 'v1',
      kind: 'ServiceList',
      metadata: { resourceVersion: '205' },
      items: [{
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'svc-empty', namespace: 'default', uid: 'svc-uid-1', resourceVersion: '14' },
      }],
    });
  }
  const descriptor = Object.values(resourceDescriptors).find(d => request.path.endsWith(`/${d.resource}`));
  return responseOf({
    apiVersion: descriptor?.group ? `${descriptor.group}/${descriptor.version}` : 'v1',
    kind: `${descriptor?.kind ?? 'Item'}List`,
    metadata: { resourceVersion: '210' },
    items: [],
  });
}

function makeController(gateway: ReturnType<typeof createResourceGateway>, configRead: Awaited<ReturnType<ReturnType<typeof createConfigReader>['read']>>, options: { helmTree?: boolean; minAutoRefreshIntervalMs?: number; now?: () => number } = {}) {
  const controller = new TreeController(async request => {
    const body = JSON.parse(request.body) as unknown;
    try {
      const result = request.path === '/v2/resources/read'
        ? await gateway.read(body, signal())
        : await gateway.readTree(body, signal());
      return { status: 200, body: JSON.stringify(result) };
    } catch (error) {
      const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
      const status = code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'QUERY_LIMIT' ? 429 : 400;
      return { status, body: JSON.stringify({ error: { code } }) };
    }
  }, () => {}, undefined, options);
  controller.configure(projectConfigPage(configRead, 'gen-1', { offset: 0, limit: 100 }), { mode: 'default' }, 'proj-1');
  return controller;
}

const findRow = (controller: TreeController, label: string) => {
  const row = controller.snapshot.rows.find(r => r.entry.node.label === label);
  assert.ok(row, `expected row ${label}`);
  return row;
};

test('RX-A03: 10-context browsing, static groups, selection, keyboard navigation, and collapseAll incur 0 cluster requests', async () => {
  const f = makeTreeGatewayFixture({ contexts: 10 });
  const configRead = await f.config.read({ mode: 'default' });
  const tree = makeController(f.gateway, configRead, { helmTree: true });

  assert.equal(tree.snapshot.rows.length, 10);
  await tree.expand(findRow(tree, 'ctx-0').id);
  await tree.expand(findRow(tree, 'Workloads').id);
  await tree.expand(findRow(tree, 'Network').id);
  await tree.expand(findRow(tree, 'Storage').id);
  await tree.expand(findRow(tree, 'Configuration').id);

  tree.select(findRow(tree, 'Deployments').id);
  tree.focus(findRow(tree, 'Pods').id);
  await tree.keyboard('ArrowDown');
  await tree.keyboard('Enter');
  await tree.keyboard(' ');
  tree.collapseAll();

  assert.equal(f.requests.length, 0);
  assert.equal(f.gateway.diagnostics().transportCalls, 0);
  assert.equal(f.gateway.diagnostics().observableHttpRequests, 0);

  tree.dispose();
  f.gateway.close();
});

test('RX-A04 / RX-A17: layered expansion counts match RX-C1 and Secrets never leak values into tree DTOs', async () => {
  const f = makeTreeGatewayFixture({ contexts: 2 });
  const configRead = await f.config.read({ mode: 'default' });
  const tree = makeController(f.gateway, configRead);

  await tree.expand(findRow(tree, 'ctx-0').id);
  await tree.expand(findRow(tree, 'Workloads').id);
  await tree.expand(findRow(tree, 'Configuration').id);
  assert.equal(f.requests.length, 0);

  // Deployments folder -> 1 LIST only, zero per-object GETs or Pod prefetch
  await tree.expand(findRow(tree, 'Deployments').id);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.purpose, 'resource-list');

  // Deployment -> 3 reads (GET + Pod LIST with labelSelector + GET)
  await tree.expand(findRow(tree, 'api').id);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests.slice(1).map(r => r.purpose), ['resource-object', 'resource-list', 'resource-object']);
  assert.equal(f.requests[2]?.query.labelSelector, 'app=api');

  // Pod -> 2 GETs only
  await tree.expand(findRow(tree, 'web-0').id);
  assert.equal(f.requests.length, 6);
  assert.deepEqual(f.requests.slice(4).map(r => r.purpose), ['resource-object', 'resource-object']);

  // Node -> fieldSelector=spec.nodeName=node-a
  await tree.expand(findRow(tree, 'Nodes').id);
  await tree.expand(findRow(tree, 'node-a').id);
  const nodePodList = f.requests.find(r => r.purpose === 'resource-list' && r.query.fieldSelector === 'spec.nodeName=node-a');
  assert.ok(nodePodList);

  // Secrets -> 2 GETs, keys only, no secret value in snapshot
  await tree.expand(findRow(tree, 'Secrets').id);
  await tree.expand(findRow(tree, 'db-secret').id);
  assert.ok(tree.snapshot.rows.some(r => r.entry.node.label === 'password'));
  assert.equal(JSON.stringify(tree.snapshot).includes('SUPER_SECRET_PASSWORD_VALUE'), false);

  const diag = f.gateway.diagnostics();
  assert.equal(diag.transportCalls, f.requests.length);
  assert.equal(diag.observableHttpRequests, f.requests.length);
  assert.ok(diag.logicalIntents >= 5);
  assert.equal(JSON.stringify(diag).includes('SUPER_SECRET_PASSWORD_VALUE'), false);

  tree.dispose();
  f.gateway.close();
});

test('RX-A05: empty Service selector sends 0 Pod LISTs, and pagination handles empty middle page and 410/byte caps', async () => {
  const f = makeTreeGatewayFixture({
    onRequest: request => {
      if (request.path.endsWith('/services')) {
        return responseOf({
          apiVersion: 'v1', kind: 'ServiceList', metadata: { resourceVersion: '10' },
          items: [{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'svc-empty', namespace: 'default', uid: 'svc-uid-1', resourceVersion: '14' } }],
        });
      }
      if (request.path.includes('/services/svc-empty')) {
        return responseOf({
          apiVersion: 'v1', kind: 'Service',
          metadata: { name: 'svc-empty', namespace: 'default', uid: 'svc-uid-1', resourceVersion: '14' },
          spec: { selector: {} },
        });
      }
      if (request.path.endsWith('/configmaps')) {
        if (!request.query.continue) {
          return responseOf({
            apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '30', continue: 'page-2-token' },
            items: Array.from({ length: 100 }, (_, i) => ({
              apiVersion: 'v1', kind: 'ConfigMap',
              metadata: { name: `cm-${String(i).padStart(3, '0')}`, namespace: 'default', uid: `cm-u-${i}`, resourceVersion: '1' },
            })),
          });
        }
        return responseOf({
          apiVersion: 'v1', kind: 'ConfigMapList', metadata: { resourceVersion: '30', continue: '' },
          items: [],
        });
      }
      return defaultTreeReply(request);
    },
  });
  const configRead = await f.config.read({ mode: 'default' });
  const tree = makeController(f.gateway, configRead);

  await tree.expand(findRow(tree, 'ctx-0').id);
  await tree.expand(findRow(tree, 'Network').id);
  await tree.expand(findRow(tree, 'Services').id);
  await tree.expand(findRow(tree, 'svc-empty').id);
  assert.equal(f.requests.filter(r => r.path.endsWith('/pods')).length, 0);

  await tree.expand(findRow(tree, 'Configuration').id);
  const cmFolder = findRow(tree, 'Config Maps');
  await tree.expand(cmFolder.id);
  assert.equal(findRow(tree, 'Config Maps').canMore, true);
  // Second page is empty middle/final page -> settles cleanly with canMore=false
  await tree.more(cmFolder.id);
  assert.equal(findRow(tree, 'Config Maps').canMore, false);

  tree.dispose();
  f.gateway.close();
});

test('RX-A10 / RX-A12 / RX-A13: default frozenRxReadLimits enforces concurrency=2, 2/sec burst=2, queue=16, 12s deadline, non-cooperating abort slot hold, and 429 Retry-After cooldown', async t => {
  let clock = 10_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let activeTransports = 0;
    let maxConcurrent = 0;
    const inflightResolvers: Array<{ resolve: (v: ReadResponse) => void; signal: AbortSignal }> = [];
    let returnStatus = 200;
    let retryAfterMs: number | undefined;

    const gate = createOutboundReadGate(async (_selection, _req, abortSignal) => {
      activeTransports++;
      maxConcurrent = Math.max(maxConcurrent, activeTransports);
      const status = returnStatus;
      const retry = retryAfterMs;
      if (status !== 200) {
        activeTransports--;
        return responseOf({ kind: 'Status', code: status }, status, retry);
      }
      return await new Promise<ReadResponse>(resolve => {
        // Deliberately ignore abortSignal to verify RX-A12 non-cooperating adapter still holds slot!
        inflightResolvers.push({ resolve, signal: abortSignal });
      }).then(resp => {
        activeTransports--;
        return resp;
      });
    }, { monotonicNow: () => clock });

    const req = (ctx: string): ResourceReadRequest => ({
      purpose: 'resource-list',
      method: 'GET',
      maximumBytes: 2_000_000,
      target: { serviceGeneration: 'g', projectId: 'p', configIdentity: 'cfg-1', context: ctx, namespace: 'default' },
      path: '/api/v1/pods',
      query: { limit: '100' },
    });

    assert.deepEqual(gate.diagnostics().limits, frozenRxReadLimits);

    // 1) Start 2 immediate requests (burst=2, concurrency=2) across two context aliases on same configIdentity
    const c1 = new AbortController();
    const p1 = gate.admit({ mode: 'default' }, req('alias-a'), c1.signal).then(async r => { await r.close(); return r.status; });
    const p2 = gate.admit({ mode: 'default' }, req('alias-b'), signal()).then(async r => { await r.close(); return r.status; });
    await settle();
    assert.equal(activeTransports, 2);
    assert.equal(maxConcurrent, 2);
    assert.equal(gate.diagnostics().inFlight, 2);

    // 2) Cancel p1 while adapter ignores abort -> slot stays occupied until p1 actually settles (RX-A12)
    c1.abort();
    await settle();
    assert.equal(gate.diagnostics().inFlight, 2);
    const p3 = gate.admit({ mode: 'default' }, req('alias-a'), signal()).then(async r => { await r.close(); return r.status; });
    await settle();
    assert.equal(activeTransports, 2, 'p3 must wait while uncooperative aborted transport holds slot');
    assert.equal(gate.diagnostics().queued, 1);

    // Complete p1 & p2
    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    await settle();
    assert.equal(await p1, 200);
    assert.equal(await p2, 200);

    // 3) Burst=2 exhausted; p3 must wait >= 500ms for 1 token at 2/sec
    assert.equal(inflightResolvers.length, 0, 'p3 must remain rate-limited before 500ms');
    clock += 500;
    t.mock.timers.tick(500);
    await settle();
    assert.equal(inflightResolvers.length, 1, 'p3 starts after 500ms token refill');
    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    await settle();
    assert.equal(await p3, 200);

    // 4) Queue overflow (> 16) + 12_000ms monotonic timeout
    clock += 2000;
    t.mock.timers.tick(2000);
    // Saturate concurrency=2
    const s1 = gate.admit({ mode: 'default' }, req('alias-a'), signal()).then(async r => { await r.close(); });
    const s2 = gate.admit({ mode: 'default' }, req('alias-a'), signal()).then(async r => { await r.close(); });
    await settle();

    // Enqueue 16 items; 17th must reject with QUERY_LIMIT
    const queuedPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 16; i++) {
      queuedPromises.push(gate.admit({ mode: 'default' }, req('alias-a'), signal()).catch(err => err));
    }
    await assert.rejects(
      gate.admit({ mode: 'default' }, req('alias-a'), signal()),
      (err: unknown) => err instanceof BoundaryError && err.code === 'QUERY_LIMIT',
    );
    assert.equal(gate.diagnostics().rejectedLimit, 1);

    // Advance 12_000ms -> all 16 queued items expire with QUERY_TIMEOUT without ever calling transport
    clock += 12_000;
    t.mock.timers.tick(12_000);
    await settle();
    const timeoutErrors = await Promise.all(queuedPromises);
    assert.ok(timeoutErrors.every(e => e instanceof BoundaryError && e.code === 'QUERY_TIMEOUT'));
    assert.equal(gate.diagnostics().timedOut, 16);

    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    await Promise.all([s1, s2]);

    // 5) 429 Retry-After cooldown blocks alias-b on same configIdentity until cooldown elapses (RX-A13)
    clock += 2000;
    t.mock.timers.tick(2000);
    returnStatus = 429;
    retryAfterMs = 3000;
    const r429 = await gate.admit({ mode: 'default' }, req('alias-a'), signal());
    await r429.close();
    assert.equal(gate.diagnostics().status429, 1);
    assert.equal(gate.diagnostics().retryAfterObserved, 1);

    returnStatus = 200;
    retryAfterMs = undefined;
    await assert.rejects(
      gate.admit({ mode: 'default' }, req('alias-a'), signal()),
      (err: unknown) => err instanceof BoundaryError && err.code === 'QUERY_LIMIT',
    );
    assert.equal(gate.diagnostics().rejectedCooldown, 1);

    clock += 3001;
    t.mock.timers.tick(3001);
    const afterCooldown = gate.admit({ mode: 'default' }, req('alias-a'), signal());
    await settle();
    inflightResolvers.shift()!.resolve(responseOf({ items: [] }));
    const okResp = await afterCooldown;
    await okResp.close();
    assert.equal(okResp.status, 200);

    gate.close();
  } finally {
    t.mock.timers.reset();
  }
});

test('RX-A11: background priority cannot starve manual reads and 5s cooldown throttles 20-Deployment Watch amplification', async t => {
  let clock = 50_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const order: string[] = [];
    const resolvers: Array<{ label: string; resolve: (v: ReadResponse) => void }> = [];
    const gate = createOutboundReadGate(async (_sel, req) => {
      return await new Promise<ReadResponse>(resolve => {
        resolvers.push({ label: req.path, resolve });
      });
    }, { monotonicNow: () => clock });

    // Background task fills the 1 background slot (backgroundMaxSlots=1)
    const bg1 = gate.withScope({ priority: 'background' }, () =>
      gate.admit({ mode: 'default' }, {
        purpose: 'resource-list',
        method: 'GET',
        maximumBytes: 2_000_000,
        target: { serviceGeneration: 'g', projectId: 'p', configIdentity: 'c', context: 'ctx', namespace: 'default' },
        path: '/bg-1', query: { limit: '100' },
      }, signal()).then(async r => { order.push('bg-1'); await r.close(); }),
    );
    // Second background task is queued (cannot take slot 2 because backgroundMaxSlots=1)
    const bg2 = gate.withScope({ priority: 'background' }, () =>
      gate.admit({ mode: 'default' }, {
        purpose: 'resource-list',
        method: 'GET',
        maximumBytes: 2_000_000,
        target: { serviceGeneration: 'g', projectId: 'p', configIdentity: 'c', context: 'ctx', namespace: 'default' },
        path: '/bg-2', query: { limit: '100' },
      }, signal()).then(async r => { order.push('bg-2'); await r.close(); }),
    );
    await settle();
    assert.equal(resolvers.length, 1);
    assert.equal(gate.diagnostics().inFlightBackground, 1);
    assert.equal(gate.diagnostics().queued, 1);

    // Manual task jumps ahead of queued bg-2 immediately using slot 2 + burst token 2
    const manual = gate.withScope({ priority: 'manual' }, () =>
      gate.admit({ mode: 'default' }, {
        purpose: 'resource-list',
        method: 'GET',
        maximumBytes: 2_000_000,
        target: { serviceGeneration: 'g', projectId: 'p', configIdentity: 'c', context: 'ctx', namespace: 'default' },
        path: '/manual', query: { limit: '100' },
      }, signal()).then(async r => { order.push('manual'); await r.close(); }),
    );
    await settle();
    assert.equal(resolvers.length, 2);
    assert.equal(resolvers[1]?.label, '/manual');

    resolvers[1]!.resolve(responseOf({ items: [] }));
    await manual;
    resolvers[0]!.resolve(responseOf({ items: [] }));
    await bg1;

    clock += 1000;
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(resolvers.length, 3);
    resolvers[2]!.resolve(responseOf({ items: [] }));
    await bg2;
    assert.deepEqual(order, ['manual', 'bg-1', 'bg-2']);
    gate.close();

    // 20-Deployment refresh queue cooldown (5_000ms per branch)
    const refreshes: string[] = [];
    const scheduledDelays: Array<{ delay: number; fn: () => void }> = [];
    const queue = new TreeRefreshQueue(
      async id => { refreshes.push(id); return { phase: 'ready', children: [] }; },
      () => {},
      cb => { cb(); return () => {}; },
      {
        minIntervalMs: 5_000,
        now: () => clock,
        scheduleDelay: (fn, delay) => {
          scheduledDelays.push({ delay, fn });
          return () => {};
        },
      },
    );
    const deps = Array.from({ length: 20 }, (_, i) => `dep-${i}`);
    queue.add(deps);
    await settle();
    assert.equal(refreshes.length, 20);

    // Rapid second wave at +1000ms must be deferred to +4000ms rather than hitting immediately
    clock += 1000;
    queue.add(deps);
    await settle();
    assert.equal(refreshes.length, 20);
    assert.ok(scheduledDelays.some(d => d.delay === 4000));

    clock += 4000;
    for (const item of scheduledDelays.splice(0)) item.fn();
    await settle();
    assert.equal(refreshes.length, 40);
    queue.dispose();
  } finally {
    t.mock.timers.reset();
  }
});

test('RX-A09 / RX-A12: duplicate expand coalesces in TreeController and context switch discards late inflight responses', async () => {
  const gateRelease = Promise.withResolvers<void>();
  let holdNext = true;
  const f = makeTreeGatewayFixture({
    onRequest: async request => {
      if (holdNext && request.path.endsWith('/deployments')) await gateRelease.promise;
      return defaultTreeReply(request);
    },
  });
  const configRead1 = await f.config.read({ mode: 'default' });
  const tree = makeController(f.gateway, configRead1);

  await tree.expand(findRow(tree, 'ctx-0').id);
  await tree.expand(findRow(tree, 'Workloads').id);
  const depFolderId = findRow(tree, 'Deployments').id;

  // Trigger two concurrent expands on Deployments while inflight
  const pA = tree.expand(depFolderId);
  const pB = tree.expand(depFolderId);
  await settle();
  assert.equal(f.requests.length, 1);

  // Switch context while pA is still inflight
  holdNext = false;
  const raw2 = multiContextKubeconfig(2, 1);
  const config2 = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: raw2 }));
  const configRead2 = await config2.read({ mode: 'default' });
  tree.configure(projectConfigPage(configRead2, 'gen-1', { offset: 0, limit: 100 }), { mode: 'default' }, 'proj-1');
  const genAfterSwitch = tree.snapshot.generation;

  gateRelease.resolve();
  await Promise.all([pA, pB]);
  assert.equal(tree.snapshot.generation, genAfterSwitch);
  assert.equal(tree.snapshot.rows.some(r => r.entry.node.label === 'api'), false);

  tree.dispose();
  f.gateway.close();
});

test('RX-A15 / RX-D4: Helm Releases tree branch paginates 100-secret chunks, marks partial pages, and aggregates revisions across pages', async () => {
  const f = makeTreeGatewayFixture({
    onRequest: request => {
      if (request.path === '/api/v1/namespaces/default') {
        return responseOf({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid: 'ns-default', resourceVersion: '1' } });
      }
      assert.equal(request.path, '/api/v1/namespaces/default/secrets');
      assert.equal(request.query.limit, '100');
      if (request.query.labelSelector === 'owner=helm,name=web') {
        return responseOf({
          apiVersion: 'v1', kind: 'SecretList',
          metadata: { resourceVersion: '500' },
          items: [
            makeHelmReleaseSecret('web', 'default', 2, 'deployed', 'u-2', '20'),
            makeHelmReleaseSecret('web', 'default', 1, 'superseded', 'u-1', '10'),
          ],
        });
      }
      assert.equal(request.query.labelSelector, 'owner=helm');
      if (!request.query.continue) {
        return responseOf({
          apiVersion: 'v1', kind: 'SecretList',
          metadata: { resourceVersion: '500', continue: 'helm-page-2' },
          items: [
            makeHelmReleaseSecret('web', 'default', 1, 'superseded', 'u-1', '10'),
          ],
        });
      }
      return responseOf({
        apiVersion: 'v1', kind: 'SecretList',
        metadata: { resourceVersion: '500' },
        items: [
          makeHelmReleaseSecret('web', 'default', 2, 'deployed', 'u-2', '20'),
        ],
      });
    },
  });
  const configRead = await f.config.read({ mode: 'default' });
  const tree = makeController(f.gateway, configRead, { helmTree: true });

  await tree.expand(findRow(tree, 'ctx-0').id);
  const helmFolder = findRow(tree, 'Helm Releases');
  await tree.expand(helmFolder.id);

  // Page 1 only: release row must be marked partial so UI does not claim full revision history
  const releasePage1 = findRow(tree, 'web');
  assert.equal(releasePage1.entry.node.partial, true);
  assert.match(releasePage1.entry.node.description ?? '', /partial/);
  assert.equal(findRow(tree, 'Helm Releases').canMore, true);

  // Load Page 2 via More: cross-page aggregation updates currentRevision to r2 and clears partial
  await tree.more(helmFolder.id);
  const releasePage2 = findRow(tree, 'web');
  assert.equal(releasePage2.entry.node.partial, false);
  assert.equal(releasePage2.entry.node.release?.currentRevision, 2);
  assert.equal(releasePage2.entry.node.release?.revisions.length, 2);
  assert.equal(findRow(tree, 'Helm Releases').canMore, false);

  // Expanding release reads 1 bounded history page (owner=helm,name=web) and shows revisions r2, r1
  const countBeforeExpand = f.requests.length;
  await tree.expand(releasePage2.id);
  assert.equal(f.requests.length, countBeforeExpand + 1);
  assert.equal(f.requests.at(-1)?.query.labelSelector, 'owner=helm,name=web');
  assert.ok(tree.snapshot.rows.some(r => r.entry.node.type === 'revision' && r.entry.node.label === '2' && (r.entry.node.description ?? '').includes('deployed')));
  assert.ok(tree.snapshot.rows.some(r => r.entry.node.type === 'revision' && r.entry.node.label === '1' && (r.entry.node.description ?? '').includes('superseded')));

  tree.dispose();
  f.gateway.close();
});
