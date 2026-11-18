import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { createResourcePager } from '../../src/service/queries/resource-pagination.ts';

const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'context', namespace: 'default' };
const type = { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' };
const query = { target, type, limit: 10 };
const continuation = 'UPSTREAM_SYNTHETIC_PRIVATE_TOKEN_+/=';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
function fixture(tokens = [continuation, '']) {
  const requests: ResourceReadRequest[] = [];
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async t => t, read: async request => {
    requests.push(request);
    const text = JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10', continue: tokens[requests.length - 1] ?? '' }, items: [] });
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(text); } }, close: async () => {} };
  } });
  return { reader, requests };
}

test('public pagination returns encrypted cursor rather than raw upstream token; next reads exactly one matching page', async () => {
  const { reader, requests } = fixture(); const pager = createResourcePager(reader);
  const first = await pager.read({ query });
  assert.ok(first.kind === 'resources' && first.nextCursor);
  assert.equal(JSON.stringify(first).includes(continuation), false); assert.equal('continue' in first, false);
  assert.equal(requests.length, 1); assert.equal(requests[0]?.query.continue, undefined);
  const second = await pager.read({ query, cursor: first.nextCursor });
  assert.ok(second.kind === 'resources'); assert.equal(second.nextCursor, null);
  assert.equal(requests.length, 2); assert.equal(requests[1]?.query.continue, continuation);
  pager.dispose(); reader.close();
});

test('populated raw API pages without item TypeMeta preserve opaque cursors and the collection snapshot', async () => {
  const requests: ResourceReadRequest[] = [];
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async t => t, read: async request => {
    requests.push(request);
    const next = request.query.continue !== undefined;
    const text = JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10', ...(next ? {} : { continue: continuation }) },
      items: [{ ...(next ? { kind: 'Pod' } : {}), metadata: { name: next ? 'second' : 'first', namespace: 'default', uid: next ? 'u2' : 'u1', resourceVersion: '8' } }] });
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text); } }, close: async () => {} };
  } });
  const pager = createResourcePager(reader);
  try {
    const first = await pager.read({ query });
    assert.ok(first.kind === 'resources' && first.nextCursor);
    assert.equal(first.nodes[0]?.resource?.name, 'first');
    assert.equal(first.resourceVersion, '10');
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(first).includes(continuation), false);
    const second = await pager.read({ query, cursor: first.nextCursor });
    assert.ok(second.kind === 'resources');
    assert.equal(second.nodes[0]?.resource?.name, 'second');
    assert.equal(second.nodes[0]?.resource?.kind, 'Pod');
    assert.equal(second.nextCursor, null);
    assert.equal(second.resourceVersion, first.resourceVersion);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.query.continue, continuation);
  } finally { pager.dispose(); reader.close(); }
});

test('query/limit/listKind/filter/target changes reject old cursor before any additional read', async () => {
  const { reader, requests } = fixture(); const pager = createResourcePager(reader);
  const first = await pager.read({ query }); assert.ok(first.kind === 'resources' && first.nextCursor);
  const changes = [{ ...query, limit: 5 }, { ...query, listKind: 'DifferentList' },
    { ...query, filter: { kind: 'selector', source: 'service', selector: { app: 'different' } } },
    ...['serviceGeneration', 'projectId', 'configIdentity', 'context', 'namespace'].map(key => ({ ...query, target: { ...target, [key]: 'other' } })),
  ];
  for (const changed of changes) await assert.rejects(pager.read({ query: changed, cursor: first.nextCursor }), fails('STALE_TARGET'));
  assert.equal(requests.length, 1); pager.dispose(); reader.close();
});

test('malformed/tampered/cross-pager and restart cursors fail closed with no crypto detail', async () => {
  const { reader, requests } = fixture(); const pager = createResourcePager(reader), other = createResourcePager(reader);
  const first = await pager.read({ query }); assert.ok(first.kind === 'resources' && first.nextCursor);
  const token = first.nextCursor;
  const changed = `${token.slice(0, 8)}${token[8] === 'A' ? 'B' : 'A'}${token.slice(9)}`;
  for (const cursor of ['rp1.a', 'wrong.token', `${token}=`, changed]) await assert.rejects(pager.read({ query, cursor }), fails('STALE_TARGET'));
  await assert.rejects(other.read({ query, cursor: token }), fails('STALE_TARGET'));
  assert.equal(requests.length, 1); pager.dispose(); other.dispose(); reader.close();
});

test('cursor lifetime is fixed across pages, not renewed by next-page reads', async () => {
  let now = 1000;
  const { reader, requests } = fixture([continuation, 'different-next', '']); const pager = createResourcePager(reader, () => now);
  const first = await pager.read({ query }); assert.ok(first.kind === 'resources' && first.nextCursor);
  now += 59_000;
  const second = await pager.read({ query, cursor: first.nextCursor }); assert.ok(second.kind === 'resources' && second.nextCursor);
  now += 1000;
  await assert.rejects(pager.read({ query, cursor: second.nextCursor }), fails('CONTINUATION_EXPIRED'));
  assert.equal(requests.length, 2); pager.dispose(); reader.close();
});

test('raw continuation/resourceVersion injection and empty-selector continuation are rejected', async () => {
  const { reader, requests } = fixture(); const pager = createResourcePager(reader);
  for (const unsafe of [{ ...query, continue: 'x' }, { ...query, resourceVersion: '10' }]) await assert.rejects(pager.read({ query: unsafe }), fails('INVALID_INPUT'));
  const emptyQuery = { ...query, filter: { kind: 'selector', source: 'service', selector: {} } };
  assert.equal((await pager.read({ query: emptyQuery })).kind, 'empty-selector'); assert.equal(requests.length, 0);
  await assert.rejects(pager.read({ query: emptyQuery, cursor: 'unused' }), fails('INVALID_INPUT'));
  pager.dispose(); reader.close();
});

test('disposing a pager rejects its cursors but does not close a shared read service', async () => {
  const { reader } = fixture(); const pager = createResourcePager(reader);
  pager.dispose(); await assert.rejects(pager.read({ query }), fails('SERVICE_CLOSED'));
  assert.equal((await reader.list(query)).kind, 'resources'); reader.close();
});

test('upstream 410 is not retried and a page completing after its deadline is never delivered', async () => {
  let calls = 0, errorBodyRead = false;
  const failedReader = createResourceReader({ serviceGeneration: 's', currentTarget: async t => t, read: async () => {
    calls++; return { status: 410, body: { async *[Symbol.asyncIterator]() { errorBodyRead = true; yield new Uint8Array(); } }, close: async () => {} };
  } });
  const failedPager = createResourcePager(failedReader);
  await assert.rejects(failedPager.read({ query }), fails('CONTINUATION_EXPIRED')); assert.equal(calls, 1); assert.equal(errorBodyRead, false);
  failedPager.dispose(); failedReader.close();
  let now = 1000;
  const lateReader = createResourceReader({ serviceGeneration: 's', currentTarget: async t => t, read: async () => {
    now += 60_000;
    const bytes = new TextEncoder().encode(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10' }, items: [] }));
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield bytes; } }, close: async () => {} };
  } });
  const latePager = createResourcePager(lateReader, () => now);
  await assert.rejects(latePager.read({ query }), fails('CONTINUATION_EXPIRED'));
  latePager.dispose(); lateReader.close();
});
