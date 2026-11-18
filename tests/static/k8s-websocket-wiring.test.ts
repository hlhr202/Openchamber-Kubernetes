// Text/metadata only. Never import or invoke the websocket adapter, session service or clients.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the websocket adapter validates its upgrade and handles HTTP rejection, head bytes, fragmentation and ping without retries', async () => {
  const adapter = await file('src/service/adapters/k8s-websocket.ts');
  for (const part of ["'Sec-WebSocket-Protocol'", 'execWebsocketProtocols', "'Sec-WebSocket-Version': '13'", 'rejectUnauthorized: true', 'decodeServerFrames', 'encodeClientFrame', 'agent: false', 'socket0?.destroy()', "request.once('response'", 'sec-websocket-accept', 'if (head.length) receive(head)', 'opcode: 10', 'fragmentBytes', 'socket.writableLength', 'credentialsRejected?.()']) assert.ok(adapter.includes(part), part);
  assert.ok(!/fetch\(|setInterval|console\.|writeFile|shell: true/.test(adapter));
});
test('the session service verifies the pod reference, bounds buffers and bridges forward channels per contract', async () => {
  const service = await file('src/service/sessions/session-service.ts');
  for (const part of ['verifyReference', 'SessionRegistry()', 'registry.sweep(now)', 'openK8sPortForward', 'sessionQuery', 'parseExitStatus', 'sessionLimits.outputBufferBytes', 'registry.close(', '4_194_304', '7000', 'owner.abort()', 'expiry.unref()', 'clearInterval(expiry)', 'opening >= 2', 'Buffer.concat(chunks).toString']) assert.ok(service.includes(part), part);
  const forward = await file('src/service/adapters/k8s-port-forward.ts');
  for (const part of ["server.listen(port.local, '127.0.0.1'", "socket.remoteAddress !== '127.0.0.1'", 'ForwardChannelDecoder', 'forwardWebsocketProtocols', 'PORT_IN_USE', 'server.once(\'error\'', 'active >= 8', 'await options.verify', 'stream.release()', 'socket.pause()', 'socket.resume()']) assert.ok(forward.includes(part), part);
  assert.ok(!/console\.|writeFile/.test(service + forward));

});
test('the terminal container and button states use explicit read-only selection, not render-time target mutation', async () => {
  const terminal = await file('src/panel/terminal-session-view.ts'), main = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts'), target = await file('src/host/session-target-client.ts');
  assert.ok(terminal.includes('mountSelect(containerSlot') && terminal.includes('sessionContainer(value)'));
  assert.ok(terminal.includes('sessionActionAvailability') && terminal.includes('showTarget(value: SessionTargetState)'));
  assert.ok(!terminal.includes("containerName || 'bash'") && !terminal.includes('value: reference ? `${reference.namespace}/${reference.name}`'));
  const render = main.slice(main.indexOf('const paintResources ='), main.indexOf('const paint ='));
  assert.ok(!render.includes('terminalSession.target('));
  assert.ok(main.includes('execForward.target(row.id, latestTreeSnapshot.generation, reference)') && main.includes('onSessionTarget(nextState'));
  assert.ok(bridge.includes('!sameTarget(target0, state.target)') && bridge.includes('sessionOpenTarget(state, kind === \'exec\')'));
  assert.ok(target.includes("path: '/v2/logs/read'") && target.includes("kind: 'containers'"));
  assert.ok(!/sessions\/|session-client|writeFile|fetch\(/.test(target));
  assert.ok(main.includes('bridge?.startTreeWatch(row.id)'));
});
test('runtime authenticates the session route, constructs the service, and closes sessions with listeners', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/sessions/handle'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.sessionService.handle(input, controller.signal)') && http.includes('options.sessionService.close()'));
  assert.ok(main.includes('createSessionService({ serviceGeneration, config, resources })'));
  assert.ok(bridge.includes('new SessionClient') && bridge.includes('podSession.open(target0, client.selection, session,') && bridge.includes('dashboardProxy'));
});
test('the panel surfaces expose explicit open/io/poll/close and the B-01 proxy with no hidden surfaces', async () => {
  const terminal = await file('src/panel/terminal-session-view.ts'), execForward = await file('src/panel/exec-forward-dashboard-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['bridge()?.openTerminal(', 'bridge()?.terminalWrite(', 'bridge()?.terminalPoll()', 'bridge()?.terminalClose()']) assert.ok(terminal.includes(part), part);
  for (const part of ['bridge()?.openSession(', 'bridge()?.sessionDashboardProxy(', 'bridge()?.listSessions()']) assert.ok(execForward.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard|storage\./.test(terminal + execForward));
  assert.ok(main.includes('mountTerminalSessionView') && main.includes('mountExecForwardDashboardView') && main.includes('terminalSession.target('));
});
test('the Port Forward prefill consumes an exact current tree row and never invokes a read or session executor', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/exec-forward-dashboard-view.ts');
  const select = bridge.slice(bridge.indexOf('sessionForwardTarget: async'), bridge.indexOf('sessionContainer:'));
  for (const part of ['snapshot.generation !== generation', 'row.stale', 'documentReferenceId(reference) !== expected', 'sameTarget(row.entry.query.target, scope)', 'false, row.entry.node.forwardPorts']) assert.ok(select.includes(part), part);
  assert.ok(!/serviceRequest|podSession\.open|resolveForwardTarget|verifyReference/.test(select));
  assert.ok(bridge.includes('forwardSelectionKey(state) !== expectedForward'));
  assert.ok(view.includes("openSession('port-forward', [], parsed, key)"));
});
test('read paths cannot reach the adapter or session service; the codec suite is registered', async () => {
  const check = await file('scripts/check-static.ts');
  assert.ok(check.includes('k8s-websocket')); // adapter in the forbidden list
  assert.ok(check.includes('operations|sessions|runtime')); // sessions stay unreachable from read graphs
  const readonly = await file('tests/readonly/k8s-websocket-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|sessions\/|operations\/|runtime\/|session-client|bridge)/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/k8s-websocket-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/k8s-websocket-wiring.test.ts'"));
});
test('admission precedes upstream effects and fast completion returns the original bounded tail result', async () => {
  const service = await file('src/service/sessions/session-service.ts'), client = await file('src/host/session-client.ts');
  const reserve = service.indexOf('registry.open({ id, kind: request.sessionKind');
  assert.ok(reserve >= 0 && reserve < service.indexOf('await openK8sPortForward(') && reserve < service.indexOf('await websocketTransport('));
  assert.ok(service.indexOf('sessions.set(id, buffers)') < service.indexOf('await openK8sPortForward('));
  assert.ok(!service.includes('owner.signal.aborted || buffers.disconnected'));
  for (const part of ['return originalResult()', 'registry.observeEnded(id,', 'pending: buffers.stdoutBytes > 0 || buffers.stderrBytes > 0']) assert.ok(service.includes(part), part);
  assert.ok(client.includes('await this.poll(false)') && client.includes('parsed.pending === true'));
  assert.ok(client.includes("if (parsed.error === 'OPERATION_UNKNOWN') this.#openUnknown = true"));
});
test('uncertain upgrades block replay and only the private session-opening job gets a longer deadline', async () => {
  const adapter = await file('src/service/adapters/k8s-websocket.ts'), runtime = await file('src/service/runtime/main.ts'), client = await file('src/host/session-client.ts');
  assert.ok(adapter.includes("request.once('error', () => { if (!settled) finish('OPERATION_UNKNOWN')"));
  assert.ok(adapter.includes("if (finished) { socket.destroy(); return; }"));
  assert.ok(adapter.includes("status === 400 || status === 426 ? 'WEBSOCKET_UPGRADE_FAILED' : 'OPERATION_UNKNOWN'"));
  assert.ok(runtime.includes("AbortSignal.timeout(sessionKind === 'open' ? 120_000 : 20_000)"));
  assert.ok(client.includes('this.#opening || this.#openUnknown') && client.includes("'SESSION_DISCONNECTED', 'WEBSOCKET_UPGRADE_FAILED'"));
});
test('background polls never renew leases and awaited config checks cannot authorize stale control', async () => {
  const service = await file('src/service/sessions/session-service.ts'), client = await file('src/host/session-client.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(client.includes('void this.poll(false)') && service.includes('request.renew === true'));
  assert.ok(client.includes('controlRevision === this.#controlRevision') && client.includes('this.#closed = this.#closed || parsed.session.closed'));
  assert.ok(client.includes('this.#id !== id || this.#controlRevoked'));
  const io = service.slice(service.indexOf("if (request.kind === 'io')"), service.indexOf("if (request.kind === 'poll')"));
  assert.ok(io.indexOf('await buffers.verifyControl?.(signal)') < io.indexOf('const current = registry.authorize'));
  assert.ok(io.includes('current.detached') && io.includes('sessions.get(request.id) !== buffers'));
  assert.ok(bridge.includes('podSession.observeScope(target())'));
});
test('Debug remains explicitly blocked without a language adapter; auxiliary results reach the current workspace', async () => {
  const debug = await file('src/service/operations/cluster-operations.ts'), client = await file('src/host/cluster-client.ts'), main = await file('src/panel/main.ts'), runtime = await file('src/service/runtime/project-runtime.ts');
  assert.ok(debug.includes("throw new BoundaryError('DEBUG_ADAPTER_REQUIRED')") && debug.includes('Node :9229 is CDP, NOT a DAP endpoint'));
  assert.ok(debug.includes('record.view.selection') && !debug.includes("projectId: 'debug'"));
  assert.ok(debug.includes('debugGate.status(request.grant, request.id)') && debug.includes("kind: z.literal('operation-status')"));
  assert.ok(client.includes("kind: 'operation-status'") && client.includes('this.#submitted = true'));
  assert.ok(main.includes("clusterView.minikubeAction(command === 'extension.vsMinikubeStart' ? 'start' : 'stop')"));
  assert.ok(runtime.includes("emit('result:sessionsOverview', value)") && runtime.includes("'minikubeConfigView', 'telepresenceStatus'"));
});
test('interactive terminal has real input and explicit resize, serialized screen restoration cannot write or open a session', async () => {
  const terminal = await file('src/panel/session-terminal-view.ts'), view = await file('src/panel/terminal-session-view.ts'), client = await file('src/host/session-client.ts');
  for (const part of ['new Terminal(', 'new SerializeAddon()', 'terminal.onData(', 'terminalOutputDelta', 'serializer.serialize({ scrollback: 128 })', "bindScene(shell, 'interactive-terminal-screen'", 'if (!replaying && writable()) input(value)', 'terminal.options.disableStdin = replaying || !writable()', 'terminal?.dispose()']) assert.ok(terminal.includes(part), part);
  assert.ok(!/openTerminal|terminalWrite|fetch\(|serviceRequest|innerHTML|writeClipboard/.test(terminal));
  assert.ok(view.includes("bridge()?.terminalWrite('', value)") && view.includes('bridge()?.openTerminal(selected.container, shell, dimensions)'));
  assert.ok(client.includes('const result = this.#inputTail.then(') && client.includes('offset += 4096') && client.includes('this.#inputBytes + bytes.length > 32_768'));
  assert.ok(client.includes('this.#inputBlocked = true') && client.includes('this.#controlRevision !== revision'));
  assert.ok(terminal.includes('terminalScreenSchema.safeParse(value)') && terminal.includes('if (writing) return committed'));
  assert.ok(client.includes('this.#inputJobs >= 64') && client.includes('availability(value: boolean)'));
  assert.ok((await file('src/host/cluster-client.ts')).includes('if (!this.#canPrepare())'));
});
