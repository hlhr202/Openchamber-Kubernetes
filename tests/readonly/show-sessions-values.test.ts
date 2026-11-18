// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { portForwardSessionSchema, showSessionsRequestSchema, showSessionsResponseSchema, sessionKey, podDisplayName, sessionLabel, stopForwardingWarning, statusBarText, statusBarTooltip } from '../../src/shared/show-sessions-protocol.ts';
const session = { pod: 'my-pod', namespace: 'kube-system', localPort: 8888, remotePort: 5000, description: 'debug' };
const bare = { pod: 'my-pod', localPort: 8888, remotePort: 5000 };
test('the session view is bounded and the request/response pair is strict', () => {
  assert.equal(portForwardSessionSchema.safeParse(session).success, true);
  assert.equal(portForwardSessionSchema.safeParse(bare).success, true);
  for (const bad of [{ pod: '', localPort: 1, remotePort: 2 }, { pod: 'p', namespace: 'Bad Ns', localPort: 1, remotePort: 2 }, { pod: 'p', localPort: 0, remotePort: 2 }, { pod: 'p', localPort: 65536, remotePort: 2 }, { pod: 'p', localPort: 1, remotePort: 65536 }, { pod: 'p', localPort: 1, remotePort: 2, description: '' }, { pod: 'p', localPort: 1, remotePort: 2, extra: 1 }]) assert.equal(portForwardSessionSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(showSessionsRequestSchema.safeParse({ protocol: 2, kind: 'read' }).success, true);
  assert.equal(showSessionsRequestSchema.safeParse({ protocol: 2, kind: 'run' }).success, false);
  assert.equal(showSessionsResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-sessions', sessions: [{ key: sessionKey(session), label: sessionLabel(session) }] }).success, true);
  assert.equal(showSessionsResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-sessions', sessions: Array.from({ length: 65 }, () => ({ key: 'k', label: 'l' })) }).success, false);
  assert.equal(showSessionsResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-sessions', sessions: [] }).success, true); // empty state is explicit, never auto-cleaned
  assert.equal(showSessionsResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-sessions-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(showSessionsResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-sessions-unavailable', code: 'NOPE' }).success, false);
});
test('the session key is upstream verbatim: namespace is part of the collision domain', () => {
  assert.equal(sessionKey(session), 'PFSESSIONKEY/my-pod/kube-system/8888');
  assert.equal(sessionKey(bare), 'PFSESSIONKEY/my-pod//8888'); // empty namespace segment upstream-verbatim
  assert.notEqual(sessionKey(session), sessionKey(bare)); // same pod+port, different namespace: no collision
});
test('display name, list label and warning are upstream verbatim including the double space', () => {
  assert.equal(podDisplayName(session), 'kube-system/my-pod');
  assert.equal(podDisplayName(bare), 'my-pod');
  assert.equal(sessionLabel(session), 'local:8888 -> kube-system/my-pod:5000');
  assert.equal(sessionLabel(bare), 'local:8888 -> my-pod:5000');
  assert.equal(stopForwardingWarning(session), 'This will stop forwarding local port 8888 to kube-system/my-pod (debug)');
  assert.equal(stopForwardingWarning({ ...bare, description: undefined }), 'This will stop forwarding local port 8888 to my-pod'); // no description suffix when absent
});
test('the status bar projections are upstream verbatim', () => {
  assert.equal(statusBarText(1), 'Kubectl Port Forwarding');
  assert.equal(statusBarText(3), 'Kubectl Port Forwarding');
  assert.equal(statusBarText(0), ''); // hidden when no sessions — the empty state
  assert.equal(statusBarTooltip(2), 'kubectl is currently running 2 port forwarding session(s) in the background.  Click to view and terminate.'); // double space verbatim
});
