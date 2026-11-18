// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalRequestSchema, terminalResponseSchema, terminalExecArguments, terminalName, bashProbeArguments, suggestedShell } from '../../src/shared/terminal-protocol.ts';
test('the request takes a bounded pod/namespace/container and a shell-token command', () => {
  assert.equal(terminalRequestSchema.safeParse({ protocol: 2, kind: 'run', pod: 'my-pod', namespace: 'default', command: 'bash' }).success, true);
  assert.equal(terminalRequestSchema.safeParse({ protocol: 2, kind: 'run', pod: 'my-pod', namespace: 'default', container: 'main', command: 'sh' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', pod: '', namespace: 'default', command: 'bash' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'Bad Ns', command: 'bash' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', container: 'x y', command: 'bash' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', command: '' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', command: 'rm -rf /' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', command: 'a'.repeat(129) },
    { protocol: 2, kind: 'read', pod: 'p', namespace: 'default', command: 'bash' },
    { protocol: 2, kind: 'run', pod: 'p', namespace: 'default', command: 'bash', extra: 1 },
  ];
  for (const bad of cases) assert.equal(terminalRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('the exec argument array is upstream verbatim with the -it flag and conditional segments', () => {
  assert.deepEqual(terminalExecArguments('my-pod', 'default', 'main', 'bash'), ['exec', '-it', 'my-pod', '--namespace', 'default', '--container', 'main', '--', 'bash']);
  assert.deepEqual(terminalExecArguments('my-pod', undefined, undefined, 'sh'), ['exec', '-it', 'my-pod', '--', 'sh']);
  assert.deepEqual(terminalExecArguments('my-pod', 'kube-system', undefined, 'sh'), ['exec', '-it', 'my-pod', '--namespace', 'kube-system', '--', 'sh']);
});
test('the terminal name keeps the upstream shape', () => {
  assert.equal(terminalName('bash', 'my-pod', 'main'), 'bash on my-pod/main');
  assert.equal(terminalName('sh', 'my-pod', undefined), 'sh on my-pod');
});
test('the bash probe invocation is upstream verbatim and the suggestion is bash-else-sh', () => {
  assert.deepEqual(bashProbeArguments('my-pod', 'default', 'main'), ['exec', 'my-pod', '--namespace', 'default', '-c', 'main', '--', 'ls', '-la', '/bin/bash']);
  assert.deepEqual(bashProbeArguments('my-pod', undefined, undefined), ['exec', 'my-pod', '--', 'ls', '-la', '/bin/bash']);
  assert.equal(suggestedShell(true), 'bash');
  assert.equal(suggestedShell(false), 'sh');
  assert.equal(terminalResponseSchema.safeParse({ protocol: 2, kind: 'terminal-opened', shell: 'bash' }).success, true);
  assert.equal(terminalResponseSchema.safeParse({ protocol: 2, kind: 'terminal-opened', shell: 'zsh' }).success, false);
  assert.equal(terminalResponseSchema.safeParse({ protocol: 2, kind: 'terminal-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(terminalResponseSchema.safeParse({ protocol: 2, kind: 'terminal-unavailable', code: 'NOPE' }).success, false);
});
