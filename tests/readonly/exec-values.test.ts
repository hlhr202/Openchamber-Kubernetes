// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execRequestSchema, execResponseSchema, execCommandText, execArguments, sharedTerminalCommand, execPromptDefault } from '../../src/shared/exec-protocol.ts';
test('the request takes bounded pod/namespace/container and a free-form single-line command', () => {
  assert.equal(execRequestSchema.safeParse({ protocol: 2, kind: 'run', pod: 'my-pod', namespace: 'default', container: 'main', command: 'ls -la /var/log' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', pod: '', namespace: 'default', container: 'main', command: 'ls' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'Bad Ns', container: 'main', command: 'ls' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'x y', command: 'ls' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'main', command: '' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'main', command: 'echo hi\nrm -rf /' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'main', command: 'x'.repeat(257) },
    { protocol: 2, kind: 'read', pod: 'p', namespace: 'default', container: 'main', command: 'ls' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'main', command: 'ls', extra: 1 },
  ];
  for (const bad of cases) assert.equal(execRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(execCommandText.safeParse('kubectl get pods -o wide').success, true); // spaces are legitimate command text
});
test('the exec invocation keeps the upstream -c short flag with the disclosed namespace fix', () => {
  assert.deepEqual(execArguments('my-pod', 'kube-system', 'main', 'ls -la /var/log'), ['exec', 'my-pod', '--namespace', 'kube-system', '-c', 'main', '--', 'ls -la /var/log']);
});
test('the shared-terminal wrapper and prompt defaults are upstream verbatim', () => {
  assert.equal(sharedTerminalCommand(['exec', 'p', '--namespace', 'ns', '-c', 'c', '--', 'ls']), 'kubectl exec p --namespace ns -c c -- ls');
  assert.equal(execPromptDefault(false), undefined); // exec path has NO default
  assert.equal(execPromptDefault(true), 'bash'); // only the terminal path defaults to bash
});
test('the response reports a bounded exit code and never claims shared-terminal display as success', () => {
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-completed', exitCode: 0 }).success, true);
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-completed', exitCode: 255 }).success, true);
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-completed', exitCode: 256 }).success, false);
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-completed', exitCode: -1 }).success, false);
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(execResponseSchema.safeParse({ protocol: 2, kind: 'exec-unavailable', code: 'NOPE' }).success, false);
});
