// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { debugAttachRequestSchema, debugAttachResponseSchema, pleaseSelectPodPlaceholder, pleaseSelectContainerPlaceholder, settingUpPortForwardingProgress, startingDebugSessionProgress, cannotResolveDebugPortMessage, learnMoreOutput, psCommand, singleSupportedProcessPid, NODE_DEFAULT_DEBUG_PORT, nodeUsr1Command, pythonAttachConfiguration, goAttachConfiguration, goSourcePlaceholder, javaAttachConfiguration, dotnetAttachRequestKind, dotnetAttachFailedOutput, DOTNET_FAILED_CHANNEL_TITLE } from '../../src/shared/debug-attach-protocol.ts';
test('the request takes an optional bounded pod/namespace/container identity and the response is a strict sextet', () => {
  assert.equal(debugAttachRequestSchema.safeParse({ protocol: 2, kind: 'attach' }).success, true);
  assert.equal(debugAttachRequestSchema.safeParse({ protocol: 2, kind: 'attach', pod: 'web-1', namespace: 'ns1', container: 'app' }).success, true);
  for (const bad of [{ pod: '' }, { pod: 'a b' }, { namespace: '-lead' }, { container: 'a'.repeat(254) }, { kind: 'debug' }, { pid: 1 }, { extra: 1 }]) assert.equal(debugAttachRequestSchema.safeParse({ protocol: 2, kind: 'attach', ...bad }).success === false, true, JSON.stringify(bad));
  for (const kind of ['workspace-required', 'pod-required', 'container-required', 'port-unresolvable']) assert.equal(debugAttachResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  assert.equal(debugAttachResponseSchema.safeParse({ protocol: 2, kind: 'attach-session-started', debuggerType: 'node' }).success, true);
  assert.equal(debugAttachResponseSchema.safeParse({ protocol: 2, kind: 'attach-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  for (const bad of [{ kind: 'attach-session-started' }, { kind: 'attach-session-started', debuggerType: '' }, { kind: 'attach-session-started', debuggerType: 'node', port: 9229 }, { kind: 'attach-unavailable', code: 'NOPE' }, { kind: 'forward-only' }, { kind: 'attach-unavailable' }]) assert.equal(debugAttachResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the pick placeholders, progress texts and port failure are upstream verbatim', () => {
  assert.equal(pleaseSelectPodPlaceholder(), 'Please select a pod to attach');
  assert.equal(pleaseSelectContainerPlaceholder(), 'Please select a container to attach');
  assert.equal(settingUpPortForwardingProgress(), 'Setting up port forwarding...');
  assert.equal(startingDebugSessionProgress('node'), 'Starting node debug session...');
  assert.equal(cannotResolveDebugPortMessage(), 'Cannot resolve the debug port to attach. See the documentation for how to use this command.');
  assert.equal(learnMoreOutput('https://example/doc'), '\nTo learn more about the usage of the debug feature, take a look at https://example/doc');
});
test('the process and USR1 probes are upstream verbatim side effects, not automatic reads', () => {
  assert.equal(psCommand('web-1', '-n ns1', '-c app'), 'exec web-1 -n ns1 -c app -- ps -o pid,command -e -w -w');
  assert.equal(singleSupportedProcessPid([{ pid: 48 }]), 48);
  assert.equal(singleSupportedProcessPid([{ pid: 1 }, { pid: 2 }]), undefined);
  assert.equal(singleSupportedProcessPid(undefined), undefined);
  assert.equal(singleSupportedProcessPid([]), undefined);
  assert.equal(NODE_DEFAULT_DEBUG_PORT, 9229);
  assert.equal(nodeUsr1Command('web-1', '-n ns1', '-c app', '/bin/sh'), 'exec web-1 -n ns1 -c app -- /bin/sh -c "kill -s USR1 1"');
});
test('the provider attach configurations and the .NET failure output are upstream verbatim', () => {
  assert.deepEqual(pythonAttachConfiguration(5678), { type: 'debugpy', request: 'attach', port: 5678 });
  assert.deepEqual(goAttachConfiguration(2345), { type: 'go', request: 'attach', port: 2345 });
  assert.equal(goSourcePlaceholder(), '/go/src/');
  assert.deepEqual(javaAttachConfiguration(8787), { type: 'java', request: 'attach', port: 8787 });
  assert.equal(dotnetAttachRequestKind(), 'attach');
  assert.equal(dotnetAttachFailedOutput('netcoredbg', 'web-1'), 'netcoredbg debug attach failed for pod web-1.\nSee https://github.com/Azure/vscode-kubernetes-tools/blob/master/debug-on-kubernetes.md for troubleshooting.');
  assert.equal(DOTNET_FAILED_CHANNEL_TITLE, 'Failed to attach');
});
