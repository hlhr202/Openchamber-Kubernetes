// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the session key, label, warning and status bar shapes', async () => {
  const ui = await file('tests/fixtures/baseline/kubernetes/src/components/kubectl/port-forward-ui.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(ui.includes('export interface PortForwardSession {'));
  assert.ok(ui.includes('registerPortForward(session: PortForwardSession): string'));
  assert.ok(ui.includes('unregisterPortForward(cookie: string): void'));
  assert.ok(ui.includes('async showSessions(): Promise<void>'));
  assert.ok(ui.includes('local:${s.localPort} -> ${podDisplayName(s)}:${s.remotePort}'));
  assert.ok(ui.includes('"Choose a port forwarding session to terminate it"'));
  assert.ok(ui.includes(`const stopForwarding = 'Stop Forwarding';`));
  assert.ok(ui.includes('This will stop forwarding local port ${session.localPort} to ${podDisplayName(session)}${description}'));
  assert.ok(ui.includes("'Kubectl Port Forwarding'"));
  assert.ok(ui.includes('kubectl is currently running ${sessionCount} port forwarding session(s) in the background.  Click to view and terminate.'));
  assert.ok(ui.includes('function keyOf(session: PortForwardSession): string {'));
  assert.ok(ui.includes('`PFSESSIONKEY/${session.podName}/${session.podNamespace || \'\'}/${session.localPort}`'));
  assert.ok(ui.includes('function podDisplayName(session: PortForwardSession): string {'));
  assert.ok(extension.includes("registerCommand('kubernetes.portForwarding.showSessions'"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/show-sessions-protocol.ts');
  for (const part of ['export function sessionKey(session: PortForwardSessionView): string', '`PFSESSIONKEY/${session.pod}/${session.namespace || \'\'}' + '/${session.localPort}`', 'export function podDisplayName(session: PortForwardSessionView): string', 'export function sessionLabel(session: PortForwardSessionView): string', 'local:${session.localPort} -> ${podDisplayName(session)}:${session.remotePort}', 'export function stopForwardingWarning(session: PortForwardSessionView): string', 'This will stop forwarding local port ${session.localPort} to ${podDisplayName(session)}${description}', 'export function statusBarText(sessionCount: number): string', "'Kubectl Port Forwarding'", 'export function statusBarTooltip(sessionCount: number): string', 'session(s) in the background.  Click to view and terminate.', 'SERVER-SIDE EXECUTION IS', 'never collide or adopt']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for session listing', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/port-forward-sessions'));
  assert.ok(!bridge.includes('ShowSessionsClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'kubernetes.portForwarding.showSessions');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M5-E006');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/show-sessions-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/show-sessions-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/show-sessions-wiring.test.ts'"));
});
