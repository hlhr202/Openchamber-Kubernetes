// M7 cluster operations: minikube status (read) + start/stop (G4 writes) and the debug chain
// (attach/launch composing the M5 session service: exec ps probe -> debug port -> port forward
// -> DAP bridge initialize; remove-debug closes bridge+sessions). Never invoked by tests.
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { configSelectionSchema } from '../../shared/configuration.ts';
import { targetSchema } from '../../shared/identity.ts';
import { errorCodes } from '../../shared/errors.ts';
import { createG4SubmitGate } from './g4-submit.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import type { MinikubeCliRunner } from '../adapters/minikube-cli.ts';
import type { TelepresenceCliRunner } from '../adapters/telepresence-cli.ts';
import type { SessionService } from '../sessions/session-service.ts';
import { openDapBridge } from '../sessions/dap-bridge.ts';
import type { DapBridge } from '../sessions/dap-bridge.ts';
import { defaultDebugPort, dapLanguages } from '../../shared/dap-protocol.ts';
import type { DapLanguage } from '../../shared/dap-protocol.ts';

// ---- protocol shapes ----
export const clusterOperationRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(1), kind: z.literal('minikube-status') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-prepare'), grant: viewGrant('minikube'), action: z.enum(['start', 'stop']), driver: z.string().regex(/^[a-z0-9-]{1,32}$/).optional() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-submit'), grant: viewGrant('minikube'), id: z.string().uuid(), proof: hex64(), confirmation: z.literal('minikube-exact-lifecycle') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-cancel'), grant: viewGrant('minikube'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-close'), grant: viewGrant('minikube') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), scope: z.enum(['minikube']), after: z.string().uuid().optional() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-prepare'), grant: viewGrant('debug'), mode: z.enum(['attach', 'launch']), language: z.enum(dapLanguages),
    pod: z.object({ namespace: z.string().min(1).max(63), name: z.string().min(1).max(253), uid: z.string().min(1).max(256), resourceVersion: z.string().min(1).max(256), container: z.string().min(1).max(253) }).strict() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-submit'), grant: viewGrant('debug'), id: z.string().uuid(), proof: hex64(), confirmation: z.literal('debug-exact-pod-language') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-cancel'), grant: viewGrant('debug'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-close'), grant: viewGrant('debug') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('operation-status'), scope: z.enum(['debug', 'minikube']), grant: viewGrant('cluster'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-remove'), grant: viewGrant('debug'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-poll'), grant: viewGrant('debug'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-send'), grant: viewGrant('debug'), id: z.string().uuid(),
    command: z.enum(['continue', 'pause', 'next', 'stepIn', 'stepOut', 'stackTrace', 'scopes', 'variables', 'setBreakpoints', 'threads', 'disconnect']),
    arguments: z.object({ lines: z.array(z.number().int().min(1).max(100_000)).max(64) }).strict().optional() }).strict()
    .refine(value => value.command !== 'setBreakpoints' || value.arguments !== undefined),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-outcomes'), scope: z.enum(['debug']), after: z.string().uuid().optional() }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('telepresence-status') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('telepresence-open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('telepresence-prepare'), grant: viewGrant('telepresence'), action: z.enum(['connect', 'intercept', 'leave', 'quit']), workload: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(253).optional(), ports: z.string().regex(/^\d{1,5}(:\d{1,5})?$/).optional() }).strict()
    .refine(value => value.action !== 'intercept' || value.workload !== undefined && value.ports !== undefined)
    .refine(value => value.action !== 'leave' || value.workload !== undefined),
  z.object({ protocol: z.literal(2), kind: z.literal('telepresence-submit'), grant: viewGrant('telepresence'), id: z.string().uuid(), proof: hex64(), confirmation: z.literal('telepresence-exact-traffic-operation') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('telepresence-cancel'), grant: viewGrant('telepresence'), id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('telepresence-close'), grant: viewGrant('telepresence') }).strict(),
]);
function hex64() { return z.string().regex(/^[a-f0-9]{64}$/); }
function viewGrant(_scope: string) {
  return z.object({ id: z.string().uuid(), capability: hex64(), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
}
export type ClusterOperationRequest = z.infer<typeof clusterOperationRequestSchema>;
const availableDebugAdapters: Readonly<Partial<Record<DapLanguage, true>>> = Object.freeze({});
type MinikubeParameters = { readonly action: 'start' | 'stop'; readonly driver?: string | undefined };
type DebugParameters = { readonly mode: 'attach' | 'launch'; readonly language: DapLanguage; readonly pod: { namespace: string; name: string; uid: string; resourceVersion: string; container: string } };
export function createClusterOperations(options: { serviceGeneration: string; lock: ConfigurationWriteLock; minikube: MinikubeCliRunner; telepresence: TelepresenceCliRunner; sessions: SessionService }) {
  const debugRecords = new Map<string, { bridge?: DapBridge; seq: number; sessions: { id: string; capability: string }[] }>();
  const minikubeGate = createG4SubmitGate<MinikubeParameters>({ serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'minikube-lifecycle', dispatchTimeoutMs: 620_000,
    lockKey: () => 'minikube',
    bind: async target => target,
    dispatch: async (record, beforeDispatch, signal) => {
      beforeDispatch();
      const parameters = record.outcome.parameters;
      const probe = parameters.action === 'start' ? await options.minikube.start(parameters.driver ?? 'docker', signal) : await options.minikube.stop(signal);
      if (probe === undefined) return { outcome: 'failed', code: 'CLI_NOT_FOUND' };
      return probe.code === 0 ? { outcome: 'accepted', details: { output: probe.stdout.slice(-2_048) } } : { outcome: 'failed', code: 'STATE_UNAVAILABLE', details: { output: probe.stdout.slice(-2_048) } };
    } });
  const debugGate = createG4SubmitGate<DebugParameters>({ serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'debug-session', dispatchTimeoutMs: 120_000,
    lockKey: () => 'debug',
    bind: async target => target,
    dispatch: async (record, beforeDispatch, signal) => {
      const parameters = record.outcome.parameters;
      beforeDispatch(); // The process probe is already an operating action, not a read-only G4 check.
      // 1) Probe the container process list over the M5 exec session channel (upstream verbatim).
      const ps = await options.sessions.handle({ protocol: 1, kind: 'open', selection: record.view.selection, target: record.view.target,
        session: { namespace: parameters.pod.namespace, pod: parameters.pod.name, podUid: parameters.pod.uid, podResourceVersion: parameters.pod.resourceVersion, container: parameters.pod.container },
        sessionKind: 'exec', command: ['ps', '-o', 'pid,command', '-e', '-w', '-w'] }, signal) as { kind?: string; capability?: string };
      if (ps?.kind !== 'session' || typeof ps.capability !== 'string') return { outcome: 'failed', code: 'STATE_UNAVAILABLE', details: { stage: 'probe' } };
      const capability = ps.capability;
      const probeId = (ps as { session?: { id?: string } }).session?.id;
      if (!probeId) return { outcome: 'failed', code: 'STATE_UNAVAILABLE', details: { stage: 'probe' } };
      const polled = await options.sessions.handle({ protocol: 1, kind: 'poll', id: probeId, capability }, signal) as { stdout?: { data?: string } };
      const text = polled?.stdout?.data ? Buffer.from(polled.stdout.data, 'base64').toString('utf8') : '';
      const supported = text.split('\n').filter(line => dapLanguages.some(language => line.includes(language) || line.includes(language === 'node' ? 'node ' : language)));
      if (!supported.length) return { outcome: 'failed', code: 'CONTENT_INVALID', details: { stage: 'process', output: text.slice(-512) } };
      const port = defaultDebugPort(parameters.language);
      if (port === undefined) return { outcome: 'failed', code: 'CONTENT_INVALID', details: { stage: 'port' } }; // bounded v1: adapter-resolved ports stay human-package
      // 2) Port forward the debug port (remote = debug port, local = same).
      const forwarded = await options.sessions.handle({ protocol: 1, kind: 'open', selection: record.view.selection, target: record.view.target,
        session: { namespace: parameters.pod.namespace, pod: parameters.pod.name, podUid: parameters.pod.uid, podResourceVersion: parameters.pod.resourceVersion, container: parameters.pod.container },
        sessionKind: 'port-forward', ports: [{ local: port, remote: port }] }, signal) as { kind?: string; capability?: string; forwarded?: { local: number }[] };
      if (forwarded?.kind !== 'session' || typeof forwarded.capability !== 'string' || !forwarded.forwarded?.length) return { outcome: 'failed', code: 'STATE_UNAVAILABLE', details: { stage: 'forward' } };
      // 3) Open the DAP bridge against the forwarded port and send initialize (attach semantics).
      const bridge = await openDapBridge('127.0.0.1', forwarded.forwarded[0]!.local, signal);
      bridge.send({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: parameters.language, clientID: 'openchamber-kubernetes', columnsStartAt1: true, linesStartAt1: true, pathFormat: 'path' } });
      debugRecords.set(record.outcome.id, { bridge, seq: 1, sessions: [{ id: (forwarded as { session?: { id?: string } }).session?.id ?? '', capability: String(forwarded.capability) }] });
      return { outcome: 'accepted', details: { port, mode: parameters.mode } };
    } });
  type TelepresenceParameters = { readonly action: 'connect' | 'intercept' | 'leave' | 'quit'; readonly workload?: string | undefined; readonly ports?: string | undefined };
  const telepresenceGate = createG4SubmitGate<TelepresenceParameters>({ serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'telepresence-traffic', dispatchTimeoutMs: 122_000,
    lockKey: () => 'telepresence',
    bind: async target => target,
    dispatch: async (record, beforeDispatch, signal) => {
      const parameters = record.outcome.parameters;
      beforeDispatch();
      const probe = parameters.action === 'connect' ? await options.telepresence.connect(signal)
        : parameters.action === 'intercept' && parameters.workload && parameters.ports ? await options.telepresence.intercept(parameters.workload, parameters.ports, signal)
        : parameters.action === 'leave' && parameters.workload ? await options.telepresence.leave(parameters.workload, signal)
        : await options.telepresence.quit(signal);
      if (probe === undefined) return { outcome: 'failed', code: 'CLI_NOT_FOUND' };
      return probe.code === 0 ? { outcome: 'accepted', details: { output: probe.stdout.slice(-2_048) } } : { outcome: 'failed', code: 'STATE_UNAVAILABLE', details: { output: probe.stdout.slice(-2_048) } };
    } });
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<unknown> {
      const request = clusterOperationRequestSchema.parse(input);
      if (request.kind === 'minikube-status') {
        const probe = await options.minikube.status(signal);
        if (probe === undefined) return { protocol: 1, kind: 'minikube-unavailable', code: 'CLI_NOT_FOUND' };
        return { protocol: 1, kind: 'minikube-status', output: probe.stdout.slice(0, 4_096), exitCode: probe.code };
      }
      if (request.kind === 'minikube-open') return { protocol: 2, kind: 'view', grant: await minikubeGate.open(request.selection, request.target, signal) };
      if (request.kind === 'minikube-prepare') {
        const prepared = await minikubeGate.prepare(request.grant, { action: request.action, ...(request.driver ? { driver: request.driver } : {}) }, undefined, signal);
        return { protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome, proof: prepared.proof, expiresAt: prepared.expiresAt };
      }
      if (request.kind === 'minikube-submit' || request.kind === 'minikube-cancel') {
        const record = request.kind === 'minikube-submit' ? minikubeGate.submit(request.grant, request.id, request.proof) : minikubeGate.cancel(request.grant, request.id);
        return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      }
      if (request.kind === 'minikube-close') { minikubeGate.closeView(request.grant); return { protocol: 2, kind: 'closed' }; }
      if (request.kind === 'outcomes') { const page = minikubeGate.outcomes(request.after); return { protocol: 2, kind: 'outcomes', outcomes: page.outcomes, next: page.next }; }
      if (request.kind === 'debug-open') return { protocol: 2, kind: 'view', grant: await debugGate.open(request.selection, request.target, signal) };
      if (request.kind === 'debug-prepare') {
        // There is no adapter contract in the current product for these five
        // languages. In particular Node :9229 is CDP, NOT a DAP endpoint.
        // Never run probes/forward sockets and claim DAP initialization succeeded.
        if (!availableDebugAdapters[request.language]) throw new BoundaryError('DEBUG_ADAPTER_REQUIRED');
        const prepared = await debugGate.prepare(request.grant, { mode: request.mode, language: request.language, pod: request.pod }, { sessions: [] }, signal);
        debugRecords.set(prepared.record.outcome.id, { seq: 0, sessions: [] });
        return { protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome, proof: prepared.proof, expiresAt: prepared.expiresAt };
      }
      if (request.kind === 'operation-status') {
        const record = request.scope === 'debug' ? debugGate.status(request.grant, request.id) : minikubeGate.status(request.grant, request.id);
        return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      }
      if (request.kind === 'debug-submit' || request.kind === 'debug-cancel') {
        const record = request.kind === 'debug-submit' ? debugGate.submit(request.grant, request.id, request.proof) : debugGate.cancel(request.grant, request.id);
        return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      }
      if (request.kind === 'debug-poll') {
        debugGate.status(request.grant, request.id);
        const attachment = debugRecords.get(request.id);
        const messages = attachment?.bridge?.drain() ?? [];
        return { protocol: 2, kind: 'debug-messages', messages: messages.slice(0, 16).map(message => JSON.stringify(message).slice(0, 4_096)) };
      }
      if (request.kind === 'debug-send') {
        debugGate.status(request.grant, request.id);
        // Bounded DAP control surface: a fixed command whitelist only; setBreakpoints carries
        // bounded line numbers. Sequence numbers are monotonic per bridge; no free-form payload
        // ever reaches the adapter.
        const entry = debugRecords.get(request.id);
        if (!entry?.bridge || entry.bridge.closed) throw new BoundaryError('SERVICE_CLOSED');
        entry.seq += 1;
        entry.bridge.send({ seq: entry.seq, type: 'request', command: request.command,
          ...(request.arguments ? { arguments: { lines: request.arguments.lines } } : request.command === 'stackTrace' || request.command === 'scopes' || request.command === 'threads' ? { arguments: {} } : {}) });
        return { protocol: 2, kind: 'debug-sent', command: request.command, seq: entry.seq };
      }
      if (request.kind === 'debug-remove') {
        debugGate.status(request.grant, request.id);
        // removeDebug: close the bridge and any forwarding sessions; never claim undo of probes.
        const attachment = debugRecords.get(request.id);
        attachment?.bridge?.close();
        debugRecords.delete(request.id);
        const cancelled = debugGate.cancel(request.grant, request.id);
        return { protocol: 2, kind: 'outcome', outcome: cancelled.outcome };
      }
      if (request.kind === 'debug-close') { debugGate.closeView(request.grant); return { protocol: 2, kind: 'closed' }; }
      if (request.kind === 'debug-outcomes') { const page = debugGate.outcomes(request.after); return { protocol: 2, kind: 'outcomes', outcomes: page.outcomes, next: page.next }; }
      if (request.kind === 'telepresence-status') {
        const probe = await options.telepresence.status(signal);
        if (probe === undefined) return { protocol: 1, kind: 'telepresence-unavailable', code: 'CLI_NOT_FOUND' };
        return { protocol: 1, kind: 'telepresence-status', output: probe.stdout.slice(0, 4_096), exitCode: probe.code };
      }
      if (request.kind === 'telepresence-open') return { protocol: 2, kind: 'view', grant: await telepresenceGate.open(request.selection, request.target, signal) };
      if (request.kind === 'telepresence-prepare') {
        const prepared = await telepresenceGate.prepare(request.grant, { action: request.action, ...(request.workload ? { workload: request.workload } : {}), ...(request.ports ? { ports: request.ports } : {}) }, undefined, signal);
        return { protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome, proof: prepared.proof, expiresAt: prepared.expiresAt };
      }
      if (request.kind === 'telepresence-submit' || request.kind === 'telepresence-cancel') {
        const record = request.kind === 'telepresence-submit' ? telepresenceGate.submit(request.grant, request.id, request.proof) : telepresenceGate.cancel(request.grant, request.id);
        return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      }
      if (request.kind === 'telepresence-close') { telepresenceGate.closeView(request.grant); return { protocol: 2, kind: 'closed' }; }
      throw new BoundaryError('INVALID_INPUT');
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate across the three G4 gates (counts only).
      const phases: Record<string, number> = {};
      for (const gate of [minikubeGate, debugGate, telepresenceGate]) {
        const state = gate.state;
        phases.inFlight = (phases.inFlight ?? 0) + state.inFlight;
        phases.unknown = (phases.unknown ?? 0) + state.unknown;
        phases.records = (phases.records ?? 0) + state.records;
      }
      return phases;
    },
    close() { for (const record of debugRecords.values()) record.bridge?.close(); debugRecords.clear(); minikubeGate.close(); debugGate.close(); telepresenceGate.close(); },
  };
}
export type ClusterOperations = ReturnType<typeof createClusterOperations>;
export const clusterErrorCode = (code: string): ErrorCode => (errorCodes as readonly string[]).includes(code) ? code as ErrorCode : 'STATE_UNAVAILABLE';
