// Pure RFC 6455 + K8s channel codec and session registry values. No sockets, no adapters.
import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeClientFrame, decodeServerFrames, channelFrame, parseChannelFrame, execChannels, portForwardChannels, portAnnouncement, parsePortAnnouncement, resizeFrame, closeChannelFrame, parseExitStatus, websocketOpcodes, k8sChannelSubprotocols } from '../../src/shared/k8s-websocket-protocol.ts';
import { SessionRegistry, sessionLimits } from '../../src/shared/session-registry.ts';

const utf8 = (text: string) => Uint8Array.from(text, character => character.charCodeAt(0));
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const target = { podUid: 'pod-uid-1', podName: 'web', namespace: 'default', container: 'app' };
test('client frames are masked with the exact 4-byte key and bounded length encodings', () => {
  const key = Uint8Array.of(1, 2, 3, 4);
  const small = encodeClientFrame({ fin: true, opcode: 2, payload: utf8('hello'), maskKey: key });
  assert.equal(small[0], 0x82); // FIN + binary
  assert.equal(small[1], 0x80 | 5); // masked + length 5
  assert.equal(small.length, 2 + 4 + 5);
  // payload "hello" XOR key = [i,a,l,l,n]-ish; verify by re-masking
  const unmasked = Uint8Array.from(small.subarray(6), (byte, index) => byte ^ key[index % 4]!);
  assert.equal(new TextDecoder().decode(unmasked), 'hello');
  const extended = encodeClientFrame({ fin: true, opcode: 2, payload: new Uint8Array(300), maskKey: key });
  assert.equal(extended[1]!, 0x80 | 126);
  assert.equal((extended[2]! << 8) | extended[3]!, 300);
  assert.equal(extended.length, 4 + 4 + 300);
  assert.equal(encodeClientFrame({ fin: false, opcode: 0, payload: new Uint8Array(0), maskKey: key })[0], 0x00);
  assert.throws(() => encodeClientFrame({ fin: true, opcode: 2, payload: new Uint8Array(0), maskKey: Uint8Array.of(1, 2, 3) }), /INVALID_INPUT/);
  assert.throws(() => encodeClientFrame({ fin: true, opcode: 2, payload: new Uint8Array(0), maskKey: Uint8Array.of(1, 2, 3, 4, 5) }), /INVALID_INPUT/);
});
test('server frame decoding is incremental, bounded and rejects masked frames', () => {
  const body = utf8('{"status":"Success"}');
  const frame = Uint8Array.from([0x82, body.length, ...body]); // FIN + binary, unmasked
  const half = decodeServerFrames(frame.subarray(0, 5));
  assert.equal(half.frames.length, 0);
  assert.equal(hex(half.remainder), hex(frame.subarray(0, 5)));
  const whole = decodeServerFrames(frame);
  assert.equal(whole.frames.length, 1);
  assert.equal(whole.frames[0]?.opcode, websocketOpcodes.binary);
  assert.equal(new TextDecoder().decode(whole.frames[0]!.payload), '{"status":"Success"}');
  const extended = Uint8Array.from([0x82, 126, 1, 0, ...new Uint8Array(256).fill(7)]);
  assert.equal(decodeServerFrames(extended).frames[0]?.payload.length, 256);
  const masked = Uint8Array.from([0x82, 0x80 | 3, 1, 2, 3]);
  assert.throws(() => decodeServerFrames(masked), /CONTENT_INVALID/);
});
test('K8s channel framing pairs channels with payloads and keeps the port contract', () => {
  assert.deepEqual(hex(channelFrame(1, utf8('out'))), `01${hex(utf8('out'))}`);
  assert.deepEqual(parseChannelFrame(channelFrame(0, utf8('in'))), { channel: 0, payload: utf8('in') });
  assert.equal(parseChannelFrame(new Uint8Array(0)), undefined);
  assert.deepEqual(portForwardChannels(0), { data: 0, error: 1 });
  assert.deepEqual(portForwardChannels(2), { data: 4, error: 5 });
  assert.deepEqual(Array.from(portAnnouncement(2, 8080)), [2, 0x90, 0x1f]); // 8080 little-endian
  assert.deepEqual(parsePortAnnouncement(portAnnouncement(4, 9090)), { channel: 4, port: 9090 });
  assert.equal(parsePortAnnouncement(Uint8Array.of(1, 2)), undefined);
  assert.deepEqual(k8sChannelSubprotocols, ['v5.channel.k8s.io', 'v4.channel.k8s.io']);
  assert.deepEqual(execChannels, { stdin: 0, stdout: 1, stderr: 2, error: 3, resize: 4, close: 255 });
  const resize = parseChannelFrame(resizeFrame(120, 30));
  assert.equal(resize?.channel, 4);
  assert.equal(JSON.parse(new TextDecoder().decode(resize?.payload)).Width, 120);
  assert.deepEqual(Array.from(closeChannelFrame(0)), [255, 0]); // v5 half-close of stdin
});
test('exit status parsing accepts Success and extracts ExitCode causes', () => {
  assert.deepEqual(parseExitStatus(utf8('{"status":"Success"}')), { exitCode: 0, message: null });
  const failure = parseExitStatus(utf8('{"status":"Failure","message":"command terminated","details":{"causes":[{"reason":"ExitCode","message":"137"}]}}'));
  assert.equal(failure.exitCode, 137);
  assert.equal(failure.message, 'command terminated');
  assert.equal(parseExitStatus(utf8('not json')).exitCode, null);
});
test('the session registry pins targets, binds capabilities and expires leases deterministically', () => {
  const registry = new SessionRegistry();
  const session = registry.open({ id: 's1', kind: 'terminal', target, owner: 'service', capabilityDigest: 'a'.repeat(64), now: 1_000 });
  assert.equal(session.closed, false);
  const renewed = registry.authorize('s1', 'a'.repeat(64), 2_000);
  assert.equal(renewed.leaseExpiresAt, 2_000 + sessionLimits.leaseMs);
  assert.throws(() => registry.authorize('s1', 'b'.repeat(64), 2_000), /FORBIDDEN/);
  assert.throws(() => registry.authorize('s1', 'a'.repeat(64), renewed.leaseExpiresAt + 1), /VIEW_EXPIRED/); // lease lapse closes it
  const registry2 = new SessionRegistry();
  registry2.open({ id: 's2', kind: 'exec', target, owner: 'service', capabilityDigest: 'c'.repeat(64), now: 1_000 });
  assert.throws(() => registry2.reattach('s2', 'c'.repeat(64), { ...target, podUid: 'other' }, 1_100), /STALE_TARGET/); // target never silently adopted
  registry2.detach('s2', 'c'.repeat(64), 1_200);
  assert.equal(registry2.reattach('s2', 'c'.repeat(64), target, 1_300).detached, false);
  assert.throws(() => registry2.open({ id: 's3', kind: 'exec', target, owner: 'service', capabilityDigest: 'd'.repeat(64), now: 1_400 }), /CONFLICT/); // duplicate live target
  registry2.close('s2', 'c'.repeat(64), 'user', 1_500);
  assert.equal(registry2.list()[0]?.closed, true);
  assert.deepEqual(registry2.sweep(9_999_999), []);
  registry2.closeAll(9_999_999, 'service-close');
  assert.ok(registry2.events().some(event => event.reason.startsWith('closed:')));
});
test('session limits bound concurrency, buffers and history', () => {
  assert.deepEqual({ ...sessionLimits }, { maxSessions: 16, maxPerKind: 8, maxRecords: 80, leaseMs: 900_000, outputBufferBytes: 262_144, outputChunk: 32_768, historyEntries: 64 });
  const registry = new SessionRegistry();
  const first = registry.open({ id: 'k0', kind: 'port-forward', target, owner: 'service', capabilityDigest: 'a'.repeat(64), now: 1 });
  void first;
  for (let index = 1; index < 8; index++) registry.open({ id: `k${index}`, kind: 'port-forward', target: { ...target, podUid: `uid-${index}` }, owner: 'service', capabilityDigest: 'a'.repeat(64), now: 1 });
  assert.throws(() => registry.open({ id: 'k9', kind: 'port-forward', target: { ...target, podUid: 'uid-9' }, owner: 'service', capabilityDigest: 'a'.repeat(64), now: 1 }), /QUERY_LIMIT/); // max 8 per kind
});
test('background and ended-output reads cannot renew a lease or authorize new input', () => {
  const registry = new SessionRegistry(), capability = 'a'.repeat(64);
  const opened = registry.open({ id: 's', kind: 'terminal', target, owner: 'project', capabilityDigest: capability, now: 1000 });
  assert.equal(registry.authorize('s', capability, 2000, true, false).leaseExpiresAt, opened.leaseExpiresAt);
  registry.observeEnded('s', 'remote-ended', 3000);
  assert.throws(() => registry.authorize('s', capability, 4000), /SERVICE_CLOSED/);
  assert.equal(registry.authorize('s', capability, 4000, true, false).closed, true);
  assert.equal(registry.authorize('s', capability, 4000, true, false).leaseExpiresAt, opened.leaseExpiresAt);
  assert.deepEqual(registry.sweep(opened.leaseExpiresAt), ['s']);
});
test('closed metadata does not permanently exhaust live-session admission after sixteen operations', () => {
  const registry = new SessionRegistry(), capability = 'a'.repeat(64);
  for (let index = 0; index < 100; index++) {
    const id = `s${index}`; registry.open({ id, kind: 'terminal', target, owner: 'project', capabilityDigest: capability, now: index });
    registry.close(id, capability, 'user', index);
  }
  assert.ok(registry.list().length <= sessionLimits.maxRecords);
  assert.ok(registry.events().length <= sessionLimits.historyEntries);
});
test('an expiry observed during authorization still schedules the owned-resource sweep once', () => {
  const registry = new SessionRegistry(), capability = 'a'.repeat(64);
  const opened = registry.open({ id: 'expires', kind: 'terminal', target, owner: 'project', capabilityDigest: capability, now: 0 });
  assert.throws(() => registry.authorize('expires', capability, opened.leaseExpiresAt), /VIEW_EXPIRED/);
  assert.deepEqual(registry.sweep(opened.leaseExpiresAt + 1), ['expires']);
  assert.deepEqual(registry.sweep(opened.leaseExpiresAt + 2), []);
});
test('pure admission reserves capacity before a fast ended record and preserves the original tail capability', () => {
  const registry = new SessionRegistry(), capability = 'a'.repeat(64);
  registry.open({ id: 'fast', kind: 'exec', target, owner: 'project', capabilityDigest: capability, now: 0 });
  assert.throws(() => registry.open({ id: 'same-target', kind: 'exec', target, owner: 'project', capabilityDigest: capability, now: 1 }), /CONFLICT/);
  registry.observeEnded('fast', 'remote-ended', 1);
  const ended = registry.authorize('fast', capability, 2, true, false);
  assert.equal(ended.id, 'fast'); assert.equal(ended.closed, true);
  assert.equal(ended.leaseExpiresAt, sessionLimits.leaseMs);
  assert.throws(() => registry.reattach('fast', capability, target, 3), /SERVICE_CLOSED/);
  registry.open({ id: 'next-explicit', kind: 'exec', target, owner: 'project', capabilityDigest: capability, now: 4 });
  assert.throws(() => registry.open({ id: 'fast', kind: 'terminal', target, owner: 'project', capabilityDigest: capability, now: 5 }), /CONFLICT/);
});
