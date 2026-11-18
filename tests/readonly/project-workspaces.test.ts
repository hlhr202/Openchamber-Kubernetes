// Memory, serialization and pure edit-buffer tests only. No runtime factory,
// bridge, authentication, write/session client, adapter, SDK, CLI or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectWorkspaces } from '../../src/service/queries/project-workspaces.ts';
import { ProjectWorkspaceConnection } from '../../src/host/project-workspace-connection.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import type { WorkspaceFrame } from '../../src/shared/project-workspace-protocol.ts';
import { samePresentation, changedPresentationProps, distinctPresentation, readTaskPresentation } from '../../src/shared/presentation-state.ts';

const origin = {
  target: { serviceGeneration: 'synthetic', projectId: 'synthetic', configIdentity: 'config', context: 'synthetic', namespace: 'default' },
  reference: { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, namespace: 'default', name: 'synthetic', uid: 'uid', resourceVersion: '1' },
  format: 'yaml' as const, contentIdentity: 'a'.repeat(64),
};
function fixture() {
  const instances = new Map<string, { buffer: DocumentBuffer; selected: string; closes: number; calls: string[] }>();
  let now = 1000, releases: (() => void)[] = [];
  const registry = createProjectWorkspaces({
    generation: 'synthetic-generation', now: () => now,
    create(input) {
      const model = { buffer: new DocumentBuffer('baseline', origin), selected: '', closes: 0, calls: [] as string[] };
      instances.set(input.directory, model);
      return {
        async invoke(method, args) {
          model.calls.push(method);
          if (method === 'choose') model.selected = String(args[0]);
          if (method === 'edit') model.buffer.edit(String(args[0]));
          if (method === 'revert') model.buffer.revert();
          if (method === 'heldObservation') await new Promise<void>(resolve => { releases.push(resolve); });
          input.emit('pure-model', { selected: model.selected, editor: model.buffer.state });
          return { value: model.selected };
        },
        selectors: () => ({ selected: model.selected, editor: model.buffer.state }),
        locale() {},
        close() { model.closes++; },
      };
    },
  });
  const requests: string[] = [];
  const frames = new Map<string, WorkspaceFrame[]>();
  const connect = async (directory: string, session: string) => {
    const list: WorkspaceFrame[] = []; frames.set(session, list);
    const connection = new ProjectWorkspaceConnection(async request => {
      requests.push(request.body);
      assert.ok(new TextEncoder().encode(request.body).length <= 64_000);
      try { return { status: 200, body: JSON.stringify(registry.handle(JSON.parse(request.body))) }; }
      catch { return { status: 400, body: JSON.stringify({ error: 'synthetic-refusal' }) }; }
    }, frame => list.push(frame), async () => {});
    await connection.attach(directory, 'zh-CN');
    return { connection, get frame() { return list.at(-1)!; } };
  };
  return { registry, instances, connect, requests, frames, advance(value: number) { now += value; }, release() { for (const release of releases) release(); releases = []; } };
}

test('A/session1 → A/session2 → B → A recreates clients, but reuses each project model without reads or reset', async () => {
  const f = fixture(), a1 = await f.connect('/synthetic/a', 'session1');
  await a1.connection.command('choose', ['pod-a']);
  await a1.connection.command('edit', ['unsaved A']);
  const ui = { route: 'document', expanded: ['a', 'pod-a'], details: { outer: true, inner: true }, search: 'ERROR', scroll: 239, selection: [2, 7] };
  await a1.connection.saveUi(ui);
  const original = f.instances.get('/synthetic/a')!;
  a1.connection.dispose();
  const a2 = await f.connect('/synthetic/a/', 'session2');
  assert.equal(f.instances.size, 1); assert.equal(f.instances.get('/synthetic/a'), original);
  assert.equal(a2.frame.selectors.selected, 'pod-a'); assert.deepEqual(a2.frame.ui?.value, ui);
  assert.equal(original.buffer.state.text, 'unsaved A'); assert.equal(original.buffer.state.dirty, true);
  a2.connection.dispose();
  const b = await f.connect('/synthetic/b', 'other-session');
  await b.connection.command('choose', ['deployment-b']);
  await b.connection.command('edit', ['unsaved B']); b.connection.dispose();
  const a3 = await f.connect('/synthetic/a', 'session1-again');
  assert.equal(a3.frame.selectors.selected, 'pod-a'); assert.deepEqual(a3.frame.ui?.value, ui);
  assert.equal(original.closes, 0); assert.equal(original.buffer.state.text, 'unsaved A');
  await a3.connection.command('revert', []);
  assert.equal(original.buffer.state.text, 'baseline', 'the private original baseline survived, not merely the displayed dirty text');
  assert.equal(f.instances.get('/synthetic/b')!.buffer.state.text, 'unsaved B');
  assert.deepEqual(original.calls, ['choose', 'edit', 'revert']);
  a3.connection.dispose(); f.registry.close();
});

test('an already-admitted pure observation finishes while its viewer is gone; reattachment sees its result', async () => {
  const f = fixture(), a = await f.connect('/synthetic/a', 'before');
  const result = a.connection.command('heldObservation', []).catch(() => undefined);
  // Admission and factory invocation are separate microtasks, not an executor.
  for (let index = 0; index < 12; index++) await Promise.resolve();
  a.connection.dispose(); f.release();
  await result;
  const restored = await f.connect('/synthetic/a', 'after');
  assert.equal(f.instances.get('/synthetic/a')!.closes, 0);
  assert.equal(restored.frame.states['pure-model']?.args.length, 1);
  restored.connection.dispose(); f.registry.close();
});

test('large Unicode drafts and UI scenes use bounded immutable chunks and incremental scene patches', async () => {
  const f = fixture(), a = await f.connect('/synthetic/a', 'large');
  const text = '合成状态😀'.repeat(32_000);
  await a.connection.command('edit', [text]);
  await a.connection.saveUi({ draft: text, caret: [3, 10] });
  const before = f.requests.length;
  await a.connection.saveUi({ draft: `${text}!`, caret: [4, 11] });
  const last = f.requests.slice(before).map(text => JSON.parse(text));
  assert.equal(last.length, 1); assert.equal(last[0].op, 'ui-patch');
  a.connection.dispose();
  const restored = await f.connect('/synthetic/a', 'large-again');
  assert.equal(restored.frame.ui?.value.draft, `${text}!`);
  assert.equal((restored.frame.selectors.editor as { text: string }).text, text);
  assert.ok(f.requests.some(value => value.includes('upload-part')));
  restored.connection.dispose(); f.registry.close();
});

test('stale scene revisions and duplicate command admissions cannot overwrite a scene or replay an action', async () => {
  const f = fixture();
  const ref = f.registry.handle({ op: 'attach', directory: '/synthetic/a', locale: 'en' }) as { workspace: string; viewer: string };
  const scope = { workspace: ref.workspace, viewer: ref.viewer };
  f.registry.handle({ op: 'ui', ...scope, revision: 0, value: { draft: 'new' } });
  assert.throws(() => f.registry.handle({ op: 'ui', ...scope, revision: 0, value: { draft: 'old' } }));
  const command = { op: 'command', ...scope, sequence: 1, method: 'choose', args: ['pod-a'] };
  f.registry.handle(command);
  assert.throws(() => f.registry.handle(command));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.instances.get('/synthetic/a')!.calls, ['choose']);
  assert.throws(() => f.registry.handle({ op: 'read', ...scope, viewer: '0'.repeat(64), after: 0, initial: true }));
  f.registry.handle({ op: 'detach', ...scope });
  assert.equal(f.instances.get('/synthetic/a')!.closes, 0);
  assert.throws(() => f.registry.handle({ op: 'read', ...scope, after: 0, initial: true }));
  f.registry.close();
});

test('viewer expiry and project admission never silently evict an old project; process loss is explicit', async () => {
  const f = fixture(), first = await f.connect('/synthetic/a', 'first');
  await first.connection.command('edit', ['keep me']);
  first.connection.dispose(); f.advance(120_000);
  for (let index = 0; index < 63; index++) f.registry.handle({ op: 'attach', directory: `/synthetic/project-${index}`, locale: 'en' });
  assert.throws(() => f.registry.handle({ op: 'attach', directory: '/synthetic/overflow', locale: 'en' }));
  const restored = await f.connect('/synthetic/a', 'restored');
  assert.equal((restored.frame.selectors.editor as { text: string }).text, 'keep me');
  assert.equal(f.instances.get('/synthetic/a')!.closes, 0);
  f.registry.close();
  await assert.rejects(() => restored.connection.read());
  assert.equal(f.instances.get('/synthetic/a')!.closes, 1);
});

test('invalid completion serialization becomes a finite error job, never a stuck pending job or unhandled rejection', async () => {
  const registry = createProjectWorkspaces({ generation: 'synthetic', create() {
    return { async invoke() { return { value: 1n }; }, selectors: () => ({}), locale() {}, close() {} };
  } });
  const attached = registry.handle({ op: 'attach', directory: '/synthetic/a', locale: 'en' }) as { workspace: string; viewer: string };
  const ref = { workspace: attached.workspace, viewer: attached.viewer };
  const job = registry.handle({ op: 'command', ...ref, sequence: 1, method: 'pureInvalidResult', args: [] }) as { id: string };
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal((registry.handle({ op: 'job', ...ref, id: job.id }) as { phase: string }).phase, 'error');
  registry.handle({ op: 'ack-job', ...ref, id: job.id }); registry.close();
});

test('an outgoing snapshot remains immutable across model updates and is released after its final bounded chunk', async () => {
  let update: ((channel: string, ...args: unknown[]) => void) | undefined;
  const registry = createProjectWorkspaces({ generation: 'synthetic', create(input) {
    update = input.emit; input.emit('model', 'old'.repeat(20_000));
    return { async invoke() { return {}; }, selectors: () => ({}), locale() {}, close() {} };
  } });
  const attached = registry.handle({ op: 'attach', directory: '/synthetic/a', locale: 'en' }) as { workspace: string; viewer: string };
  const ref = { workspace: attached.workspace, viewer: attached.viewer };
  type Chunk = { id: string; data: string; end: number; complete: boolean };
  let chunk = registry.handle({ op: 'read', ...ref, initial: true, after: 0 }) as Chunk;
  const id = chunk.id, parts = [Buffer.from(chunk.data, 'base64')];
  update?.('model', 'new');
  while (!chunk.complete) {
    chunk = registry.handle({ op: 'read', ...ref, initial: true, after: 0, cursor: id, offset: chunk.end }) as Chunk;
    parts.push(Buffer.from(chunk.data, 'base64'));
  }
  assert.equal(JSON.parse(Buffer.concat(parts).toString()).states.model.args[0], 'old'.repeat(20_000));
  assert.throws(() => registry.handle({ op: 'read', ...ref, initial: true, after: 0, cursor: id, offset: 0 }));
  registry.close();
});

test('a selector-only change is delivered even when the pure model emits no state callback', async () => {
  let ready = false, latest: WorkspaceFrame | undefined;
  const registry = createProjectWorkspaces({ generation: 'synthetic', create() {
    return { async invoke() { ready = true; return {}; }, selectors: () => ({ ready }), locale() {}, close() {} };
  } });
  const connection = new ProjectWorkspaceConnection(async request => ({ status: 200, body: JSON.stringify(registry.handle(JSON.parse(request.body))) }), frame => { latest = frame; }, async () => {});
  await connection.attach('/synthetic/a', 'en');
  assert.equal(latest?.selectors.ready, false);
  await connection.command('choosePureTarget', []);
  assert.equal(latest?.selectors.ready, true);
  connection.dispose(); registry.close();
});
test('1000 identical large state emissions do not clone a new frame, increment its revision or notify a viewer', () => {
  let emit: ((channel: string, ...args: unknown[]) => void) | undefined;
  const state = { phase: 'ready', output: '合成数据'.repeat(32_000), closed: false, target: { name: 'synthetic' } };
  const registry = createProjectWorkspaces({ generation: 'synthetic', create(input) {
    emit = input.emit; input.emit('model', state);
    return { async invoke() { return {}; }, selectors: () => ({}), locale() {}, close() {} };
  } });
  const ref = registry.handle({ op: 'attach', directory: '/synthetic/a', locale: 'en' }) as { workspace: string; viewer: string; version: number };
  for (let index = 0; index < 1000; index++) emit?.('model', { ...state, target: { name: 'synthetic' } });
  assert.deepEqual(registry.handle({ op: 'read', workspace: ref.workspace, viewer: ref.viewer, after: ref.version, initial: false }), { kind: 'unchanged', version: ref.version });
  emit?.('model', { ...state, closed: true, error: 'SESSION_DISCONNECTED' });
  const changed = registry.handle({ op: 'read', workspace: ref.workspace, viewer: ref.viewer, after: ref.version, initial: false }) as { kind: string; version: number };
  assert.equal(changed.kind, 'frame'); assert.equal(changed.version, ref.version + 1);
  registry.close();
});
test('presentation equality detects errors, targets, cursor and loss changes; callback props are never compared as JSON', () => {
  assert.equal(samePresentation({ a: 1, b: ['x'] }, { b: ['x'], a: 1 }), true);
  for (const patch of [{ error: 'STATE_UNAVAILABLE' }, { next: 2 }, { lost: true }, { target: 'other' }]) assert.equal(samePresentation({ next: 1, lost: false, target: 'original' }, { next: 1, lost: false, target: 'original', ...patch }), false);
  const onChange = () => {};
  const props = { value: 'app', label: 'Container', disabled: false, options: [{ id: 'app', label: 'App' }], onChange };
  assert.equal(changedPresentationProps(props, { label: 'Container', options: [{ id: 'app', label: 'App' }] }), undefined);
  assert.deepEqual(changedPresentationProps(props, { disabled: true }), { disabled: true });
  assert.ok(changedPresentationProps(props, { onChange: () => {} })?.onChange);
  assert.equal(samePresentation(new Date(0), new Date(0)), false);
});
test('lease-only heartbeat publications are silent while real repeated log events and lifecycle changes are delivered', () => {
  const seen: unknown[] = [];
  const base = { phase: 'running', text: 'same line', page: { next: 1, head: 1, leaseUntil: 1, events: [] as unknown[] } };
  const publish = distinctPresentation<typeof base>(value => { seen.push(value); }, readTaskPresentation);
  publish(base);
  for (let index = 0; index < 1000; index++) publish({ ...base, page: { ...base.page, leaseUntil: index + 2 } });
  assert.equal(seen.length, 1);
  publish({ ...base, page: { ...base.page, next: 2, head: 2, events: [{ sequence: 2, text: 'same line' }] } });
  publish({ ...base, page: { ...base.page, next: 3, head: 3, events: [{ sequence: 3, text: 'same line' }] } });
  publish({ ...base, phase: 'completed' });
  assert.equal(seen.length, 4, 'no log line is deduplicated by its text');
});
