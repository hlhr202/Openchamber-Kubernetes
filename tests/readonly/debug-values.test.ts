// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { debugRequestSchema, debugResponseSchema, selectEnvironmentPlaceholder, legacyDebuggerTypes, workspaceRequiredMessage, buildingImageProgress, imageBuiltMessage, pushingImageProgress, imagePushedMessage, pushFailedUnableMessage, pushDiagnosticMessage, buildFailedUnableMessage, buildFailedMessage, failedBuildingPushingMessage, debugCommandPrompt, debugCommandPlaceholder, inputErrorMessage, debugDeploymentName, debugRunCommand, failedToStartDebugContainerMessage, failedToFindDebugPodMessage, debugPodRunningMessage, podPhaseCommand, isPodRunning, POD_READY_RETRY_MS, debugPortForwardCommand, attachConfiguration, debugSessionEstablishedMessage, EXPOSE_SERVICE_BUTTON, exposePortPrompt, exposePortPlaceholder, exposeCommand, failedToExposeMessage, deploymentExposedMessage, portInfoErrorMessage, exposeInfoErrorMessage, noImagePrefixMessage, buildingDockerImageProgress, runningImageProgress } from '../../src/shared/debug-protocol.ts';
test('the request is a bare debug and the response is a strict sextet', () => {
  assert.equal(debugRequestSchema.safeParse({ protocol: 2, kind: 'debug' }).success, true);
  for (const bad of [{ kind: 'attach' }, { kind: 'debug', image: 'x' }, { extra: 1 }]) assert.equal(debugRequestSchema.safeParse({ protocol: 2, kind: 'debug', ...bad }).success === false, true, JSON.stringify(bad));
  for (const kind of ['workspace-required', 'environment-required', 'legacy-build-initiated', 'debug-workload-started', 'debug-session-established']) assert.equal(debugResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  assert.equal(debugResponseSchema.safeParse({ protocol: 2, kind: 'debug-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  for (const bad of [{ kind: 'debug-unavailable', code: 'NOPE' }, { kind: 'debug-unavailable' }, { kind: 'debug-session-established', config: {} }, { kind: 'auto-cleaned' }, { kind: 'config-only' }]) assert.equal(debugResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the picks, gates and legacy build/push texts are upstream verbatim', () => {
  assert.equal(selectEnvironmentPlaceholder(), 'Select the environment');
  assert.deepEqual(legacyDebuggerTypes(), ['node']);
  assert.equal(workspaceRequiredMessage(), 'This command requires an open folder.');
  assert.equal(buildingImageProgress(), 'Building an image...');
  assert.equal(imageBuiltMessage('app:1'), 'app:1 built.');
  assert.equal(pushingImageProgress(), 'Pushing the image...');
  assert.equal(imagePushedMessage('app:1'), 'app:1 pushed.');
  assert.equal(pushFailedUnableMessage('Docker'), 'Image push failed; unable to call Docker.');
  assert.equal(pushDiagnosticMessage('denied', 'Docker'), 'denied See Output window for Docker push error message.');
  assert.equal(buildFailedUnableMessage('Docker'), 'Image build failed; unable to call Docker.');
  assert.equal(buildFailedMessage(), 'Image build failed. See Output window for details.');
  assert.equal(failedBuildingPushingMessage('boom'), 'Failed building/pushing an image: boom');
  assert.equal(noImagePrefixMessage(), "No Docker image prefix set for image push. Please set 'vsdocker.imageUser' in your Kubernetes extension settings.");
  assert.equal(buildingDockerImageProgress(), 'Building Docker image...');
  assert.equal(runningImageProgress(), 'Running Docker image on Kubernetes...');
});
test('the debug workload invocation, readiness poll and port-forward are upstream verbatim', () => {
  assert.equal(debugCommandPrompt(), 'Debug command for your container:');
  assert.equal(debugCommandPlaceholder(), 'Example: node debug server.js');
  assert.equal(inputErrorMessage('x'), 'Error getting input: x');
  assert.equal(debugDeploymentName('app'), 'app-debug');
  assert.equal(debugRunCommand('app', 'img:1', 'node debug server.js'), 'run app-debug --image=img:1 -i --attach=false -- node debug server.js');
  assert.equal(failedToStartDebugContainerMessage(), 'Failed to start debug container');
  assert.equal(failedToFindDebugPodMessage(), 'Failed to find debug pod.');
  assert.equal(debugPodRunningMessage('app-debug-abc'), 'Debug pod running as: app-debug-abc');
  assert.equal(podPhaseCommand('app-debug-abc'), ' get pods app-debug-abc -o jsonpath --template="{.status.phase}"');
  assert.equal(isPodRunning('Running'), true);
  assert.equal(isPodRunning('Pending'), false);
  assert.equal(POD_READY_RETRY_MS, 1000);
  assert.equal(debugPortForwardCommand('app-debug-abc'), ' port-forward app-debug-abc 5858:5858 8000:8000');
});
test('the attach configuration and the optional expose leg are upstream verbatim', () => {
  assert.deepEqual(attachConfiguration('/work/app'), { type: 'node', request: 'attach', name: 'Attach to Process', port: 5858, localRoot: '/work/app', remoteRoot: '/' });
  assert.equal(debugSessionEstablishedMessage(), 'Debug session established');
  assert.equal(EXPOSE_SERVICE_BUTTON, 'Expose Service');
  assert.equal(exposePortPrompt(), 'Expose on which port?');
  assert.equal(exposePortPlaceholder(), '80');
  assert.equal(exposeCommand('app-debug', '80'), 'expose deployment app-debug --type=LoadBalancer --port=80');
  assert.equal(failedToExposeMessage('boom'), 'Failed to expose deployment: boom');
  assert.equal(deploymentExposedMessage('app-debug'), 'Deployment exposed. Run Kubernetes Get > service app-debug for IP address');
  assert.equal(portInfoErrorMessage('x'), 'Error getting port info: x');
  assert.equal(exposeInfoErrorMessage('y'), 'Error getting expose info: y');
});
