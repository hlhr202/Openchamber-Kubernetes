// Pure M3 DTO production and detached local output sink only. No xterm/DOM/SDK, PTY, sessions or controls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { logOutputFrameSchema } from '../../src/shared/log-output-protocol.ts';
import type { LogOutputFrame } from '../../src/shared/log-output-protocol.ts';
import { LogOutputProducer } from '../../src/host/log-output-producer.ts';
import { LogTerminalOutput } from '../../src/host/log-terminal-output.ts';
import type { LogTerminalStatus } from '../../src/host/log-terminal-output.ts';
import type { PodLogState } from '../../src/host/pod-log-client.ts';
import type { LogFollowState } from '../../src/host/log-follow-client.ts';
const source = { target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, reference: { resource: 'pods' as const, name: 'pod', namespace: 'default', uid: 'pod-u', resourceVersion: 'p1' }, container: 'main', options: { timestamps: false, sinceSeconds: null, tailLines: null } };
const frame = (change: Partial<LogOutputFrame> = {}): LogOutputFrame => ({ protocol: 1, kind: 'log-output', source, stream: { kind: 'follow', id: 'task' }, sequence: 1, cursor: 0, action: 'reset', text: '', phase: 'running', partial: false, ...change });
const snapshot = (text: string, end = text.length, id = '00000000-0000-4000-8000-000000000001'): PodLogState => ({ phase: 'ready', stale: false, text, complete: false, containers: [{ name: 'main', kind: 'regular' }],
  source: { protocol: 2, kind: 'read', ...source, selection: { mode: 'default' } }, page: { protocol: 2, kind: 'pod-log', ...source, snapshotId: id, totalBytes: 1_000_000, totalCharacters: 1_000_000, offset: 0, end, text: text.slice(-65_536), nextCursor: 'next' } });
function following(text: string, next: number, events: Array<{ text: string; sequence: number }>, lost = false): LogFollowState {
  const value = { protocol: 2 as const, ...source, selection: { mode: 'default' as const } };
  return { phase: 'running', source: value, text, truncated: lost, page: { protocol: 2, kind: 'pod-log-follow', source: value, handle: { generation: 's', task: 'task', consumer: '00000000-0000-4000-8000-000000000001', token: 'a'.repeat(64), epoch: 1 },
    phase: 'running', expiresAt: 60_000, leaseUntil: 15_000, first: events[0]?.sequence ?? next + 1, next, head: next, lost, events } };
}
function sinkFixture() {
  const writes: string[] = [], callbacks: Array<() => void> = [], statuses: LogTerminalStatus[] = []; let resets = 0, disposed = 0;
  const output = new LogTerminalOutput({ write(text, done) { writes.push(text); callbacks.push(done); }, reset() { resets++; }, dispose() { disposed++; } }, value => statuses.push(value));
  return { output, writes, callbacks, statuses, resets: () => resets, disposed: () => disposed, drain() { for (let n = 0; callbacks.length && n < 1000; n++) callbacks.shift()?.(); } };
}
test('strict output-only DTO keeps source/stream/cursor/phase but rejects any writable handles or arbitrary fields', () => {
  assert.ok(logOutputFrameSchema.safeParse(frame()).success);
  for (const key of ['handle', 'token', 'stdin', 'resize', 'exec', 'selection', 'path']) assert.equal(logOutputFrameSchema.safeParse({ ...frame(), [key]: 'SYNTHETIC_SECRET' }).success, false);
});
test('source DTO rejects foreign Job namespace, invalid container and state text without a text action', () => {
  assert.equal(logOutputFrameSchema.safeParse(frame({ source: { ...source, container: '../shell' } })).success, false);
  assert.equal(logOutputFrameSchema.safeParse(frame({ action: 'state', text: 'not-state' })).success, false);
  assert.equal(logOutputFrameSchema.safeParse(frame({ source: { ...source, origin: { resource: 'jobs', name: 'job', uid: 'j-u', resourceVersion: 'j1', namespace: 'other' } } })).success, false);
});
test('finite producer emits only new snapshot suffix, never repeats already displayed chunks', () => {
  const producer = new LogOutputProducer(); assert.equal(producer.snapshot(snapshot('abc'))?.action, 'reset'); const next = producer.snapshot(snapshot('abcdef'));
  assert.equal(next?.action, 'append'); assert.equal(next?.text, 'def'); assert.equal(next?.cursor, 6); assert.equal(producer.snapshot(snapshot('abcdef'))?.action, 'state');
});
test('finite source/snapshot identity changes are a reset rather than appending foreign output', () => {
  const producer = new LogOutputProducer(); producer.snapshot(snapshot('old')); const next = producer.snapshot(snapshot('new', 3, '00000000-0000-4000-8000-000000000002'));
  assert.equal(next?.action, 'reset'); assert.equal(next?.sequence, 1); assert.equal(next?.text, 'new');
});
test('oversized late snapshot is explicitly refused, not silently replayed or truncated into a fake complete terminal', () => {
  assert.throws(() => new LogOutputProducer().snapshot(snapshot('x'.repeat(65_537))), /BUDGET_EXCEEDED/);
});
test('Follow uses event sequence not retained text equality, so identical repeated lines are never deduplicated', () => {
  const producer = new LogOutputProducer(); producer.follow(following('', 0, [])); producer.follow(following('same\n', 1, [{ text: 'same\n', sequence: 1 }]));
  const next = producer.follow(following('same\n', 2, [{ text: 'same\n', sequence: 2 }])); assert.equal(next?.action, 'append'); assert.equal(next?.text, 'same\n'); assert.equal(next?.cursor, 2);
});
test('Follow rolling retained window does not trigger replay or drop a valid newly sequenced chunk', () => {
  const producer = new LogOutputProducer(); producer.follow(following('old', 1, [{ text: 'old', sequence: 1 }])); const next = producer.follow(following('new', 2, [{ text: 'new', sequence: 2 }]));
  assert.equal(next?.action, 'append'); assert.equal(next?.text, 'new');
});
test('ring loss resets to the current partial retained window instead of joining across missing logs', () => {
  const producer = new LogOutputProducer(); producer.follow(following('old', 1, [{ text: 'old', sequence: 1 }])); const next = producer.follow(following('tail', 30, [{ text: 'tail', sequence: 30 }], true));
  assert.equal(next?.action, 'reset'); assert.equal(next?.partial, true); assert.equal(next?.text, 'tail');
});
test('repainting the same lost Follow page emits state only, never resets or replays its retained window', () => {
  const producer = new LogOutputProducer(), page = following('tail', 30, [{ text: 'tail', sequence: 30 }], true);
  assert.equal(producer.follow(page)?.action, 'reset'); const next = producer.follow(page);
  assert.equal(next?.action, 'state'); assert.equal(next?.text, ''); assert.equal(next?.partial, true);
});
test('Follow Clear preserves cursor/stream while resetting display and Stop preserves existing visible text', () => {
  const producer = new LogOutputProducer(); const before = following('old', 1, [{ text: 'old', sequence: 1 }]); producer.follow(before);
  const cleared = producer.follow({ phase: 'running', source: before.source!, text: '', truncated: false }); assert.equal(cleared?.action, 'reset'); assert.equal(cleared?.cursor, 1);
  const resumed = producer.follow(following('new', 2, [{ text: 'new', sequence: 2 }])); assert.equal(resumed?.text, 'new');
  const stopped = producer.follow({ phase: 'error', source: before.source!, text: 'new', truncated: false, error: 'QUERY_CANCELLED' }); assert.equal(stopped?.action, 'state'); assert.equal(stopped?.error, 'QUERY_CANCELLED');
});
test('noncontiguous or regressed Follow cursor cannot be converted into plausible terminal output', () => {
  const producer = new LogOutputProducer(); producer.follow(following('old', 1, [{ text: 'old', sequence: 1 }])); assert.throws(() => producer.follow(following('foreign', 3, [{ text: 'foreign', sequence: 3 }])), /STATE_UNAVAILABLE/);
  assert.throws(() => producer.follow(following('', 0, [])), /STALE_TARGET/);
});
test('idle/containers clear producer history and source projection strips selection paths and all capability tokens', () => {
  const producer = new LogOutputProducer(); const value = following('safe', 1, [{ text: 'safe', sequence: 1 }]); const output = producer.follow(value); assert.ok(output);
  const serialized = JSON.stringify(output); assert.equal(serialized.includes('selection'), false); assert.equal(serialized.includes('consumer'), false); assert.equal(serialized.includes('a'.repeat(64)), false);
  assert.equal(producer.follow({ phase: 'idle', text: '', truncated: false }), null);
});
test('terminal sink writes only one escaped 4096-character raw chunk until its parser callback settles', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'x'.repeat(9000) })); assert.equal(f.writes.length, 1); assert.equal(f.writes[0]?.length, 4096); f.callbacks.shift()?.(); assert.equal(f.writes.length, 2); f.drain(); assert.equal(f.writes.join('').length, 9000); f.output.dispose();
});
test('UTF-16 split boundaries remain whole in actual terminal display writes', () => {
  const f = sinkFixture(), text = 'x'.repeat(4095) + '🌏z'; f.output.accept(frame({ text })); f.drain(); assert.equal(f.writes[0]?.length, 4095); assert.equal(f.writes.join(''), text); f.output.dispose();
});
test('ANSI/OSC/clipboard/URL controls remain escaped text before reaching the local terminal parser', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: '\x1b]52;c;SYNTHETIC\x07\x1b[31mhttps://synthetic.invalid\x9b' })); f.drain(); const text = f.writes.join(''); assert.equal(text.includes('\x1b'), false); assert.equal(text.includes('\x07'), false); assert.equal(text.includes('\x9b'), false); assert.ok(text.includes('\\u001b]52')); f.output.dispose();
});
test('source change masks old output, waits for actual old parser callback, then resets before new bytes', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'old'.repeat(3000) })); f.output.accept(frame({ stream: { kind: 'follow', id: 'new-task' }, text: 'new' }));
  assert.equal(f.statuses.at(-1)?.masked, true); assert.equal(f.resets(), 1); assert.equal(f.writes.length, 1); f.callbacks.shift()?.(); assert.equal(f.resets(), 2); assert.equal(f.writes.at(-1), 'new'); f.drain(); assert.equal(f.writes.length, 2); f.output.dispose();
});
test('Clear while parsing waits without phantom slot release and clears the real terminal once settled', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'old'.repeat(2000) })); f.output.clear(); assert.equal(f.resets(), 1); assert.equal(f.statuses.at(-1)?.masked, true);
  f.callbacks.shift()?.(); assert.equal(f.resets(), 2); assert.equal(f.writes.length, 1); assert.equal(f.statuses.at(-1)?.masked, false); f.output.dispose();
});
test('upstream projection failure masks and drops old queued bytes even after the old parser callback settles', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'old'.repeat(3000) })); f.output.fail('BUDGET_EXCEEDED');
  assert.equal(f.statuses.at(-1)?.masked, true); f.drain(); assert.equal(f.writes.length, 1);
  assert.equal(f.statuses.at(-1)?.error, 'BUDGET_EXCEEDED'); assert.equal(f.resets(), 1);
  f.output.clear(); assert.equal(f.resets(), 2); assert.equal(f.statuses.at(-1)?.masked, false); f.output.dispose();
});
test('sequence/source/cursor substitution fails closed before a foreign terminal write', () => {
  for (const change of [{ sequence: 5 }, { source: { ...source, container: 'other' }, sequence: 2 }, { cursor: 0, sequence: 2 }]) {
    const f = sinkFixture(); f.output.accept(frame({ cursor: 1, text: 'original' })); f.drain(); f.output.accept(frame({ action: 'append', text: 'foreign', ...change })); assert.equal(f.statuses.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.writes.join(''), 'original'); f.output.dispose();
  }
});
test('render text admission caps current queued bytes rather than accumulating an unbounded hidden backlog', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'a'.repeat(65_536) })); f.output.accept(frame({ sequence: 2, action: 'append', cursor: 1, text: 'b'.repeat(65_536) })); f.output.accept(frame({ sequence: 3, action: 'append', cursor: 2, text: 'c' })); assert.equal(f.statuses.at(-1)?.error, 'BUDGET_EXCEEDED'); f.output.dispose();
});
test('metadata-only frames also have a total queue count cap while parsing is stalled', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'pending' })); for (let n = 2; n <= 10; n++) f.output.accept(frame({ sequence: n, action: 'state' })); assert.ok(f.statuses.some(state => state.error === 'BUDGET_EXCEEDED')); f.output.dispose();
});
test('sink errors become fixed masked failures, never original terminal/output diagnostics', () => {
  const states: LogTerminalStatus[] = []; const output = new LogTerminalOutput({ write() { throw new Error('SYNTHETIC_SECRET'); }, reset() {}, dispose() {} }, state => states.push(state)); output.accept(frame({ text: 'hello' })); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes('SYNTHETIC_SECRET'), false); output.dispose();
});
test('dispose owns only the local renderer, ignores stale write callbacks and never creates input/control identities', () => {
  const f = sinkFixture(); f.output.accept(frame({ text: 'pending'.repeat(2000) })); f.output.dispose(); const count = f.statuses.length; f.drain(); f.output.accept(frame()); assert.equal(f.disposed(), 1); assert.equal(f.statuses.length, count); assert.equal(f.writes.length, 1);
});
test('producer output is bounded per frame even when a snapshot accumulates all sixteen original chunks', () => {
  const producer = new LogOutputProducer(); let text = ''; for (let n = 0; n < 16; n++) { text += 'x'.repeat(65_536); const value = producer.snapshot(snapshot(text)); assert.equal(value?.text.length, 65_536); } assert.equal(text.length, 1_048_576);
});
