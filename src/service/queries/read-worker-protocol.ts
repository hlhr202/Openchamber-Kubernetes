import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { containsControlCharacters, targetSchema } from '../../shared/identity.ts';
import { validateKubectlReadRequest } from './kubectl-plan.ts';
import { customDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import { customWatchReferenceSchema } from '../../shared/watch-protocol.ts';
import { manifestComparisonReferenceSchema } from '../../shared/manifest-diff-protocol.ts';

export const readWorkerFlag = '--oc-k8s-read-worker-v1';
export const readWorkerDeadlineMs = 8000;
export const logFollowWorkerDeadlineMs = 55_000;
const bytes = (maximum: number) => z.instanceof(Uint8Array).refine(value => value.byteLength <= maximum);
const requestSchema = z.object({ method: z.literal('GET'), purpose: z.enum(['resource-list', 'api-version', 'api-group', 'api-root', 'namespace-inventory', 'custom-resource-definitions', 'resource-object', 'custom-document', 'custom-wide', 'custom-describe', 'custom-resource-watch', 'custom-resource-relist', 'pod-logs', 'namespace-events', 'resource-wide', 'resource-describe', 'cluster-info', 'openapi-index', 'openapi-schema', 'resource-watch', 'pod-log-follow', 'namespace-event-watch', 'job-pod-watch', 'manifest-diff', 'manifest-create-proof', 'helm-releases']),
  target: targetSchema, path: z.string().min(1).max(4096), maximumBytes: z.union([z.literal(2_000_000), z.literal(8_000_000)]),
  customDocument: customDocumentReferenceSchema.optional(),
  customInspection: customDocumentReferenceSchema.optional(),
  customWatch: customWatchReferenceSchema.optional(),
  comparison: manifestComparisonReferenceSchema.optional(),
  createReference: manifestComparisonReferenceSchema.optional(),
  query: z.record(z.string().max(32), z.string().max(8192)).refine(value => Object.keys(value).length <= 5) }).strict()
  .refine(value => value.purpose === 'pod-log-follow' || Object.keys(value.query).length <= 4);
const startSchema = z.object({ protocol: z.literal(1), kind: z.literal('read'), request: requestSchema,
  snapshot: bytes(8_000_000).refine(value => value.byteLength > 0),
  path: z.string().min(1).max(32_000).refine(value => !containsControlCharacters(value)) }).strict();
export type ReadWorkerStart = z.infer<typeof startSchema>;
const failureCodes = ['QUERY_CANCELLED', 'QUERY_TIMEOUT', 'BUDGET_EXCEEDED', 'INVALID_INPUT', 'STATE_UNAVAILABLE',
  'CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'READ_TRANSPORT_UNAVAILABLE', 'AUTHENTICATION_UNAVAILABLE', 'CONFIG_INVALID', 'STALE_TARGET'] as const;
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ protocol: z.literal(1), ok: z.literal(true), status: z.union([z.literal(200), z.literal(401), z.literal(403), z.literal(404), z.literal(410), z.literal(429), z.literal(500)]),
     retryAfterMs: z.number().int().min(1).max(60_000).optional(), body: bytes(8_000_000) }).strict().refine(value => value.status === 200 || value.body.byteLength === 0),
  z.object({ protocol: z.literal(1), ok: z.literal(false), code: z.enum(failureCodes) }).strict(),
]);
export type ReadWorkerResult = z.infer<typeof resultSchema>;
export const watchChunkSchema = z.object({ protocol: z.literal(1), kind: z.literal('watch-chunk'), sequence: z.number().int().min(1).max(2048), body: bytes(16_384).refine(value => value.byteLength > 0) }).strict();
export const watchAckSchema = z.object({ protocol: z.literal(1), kind: z.literal('watch-ack'), sequence: z.number().int().min(1).max(2048) }).strict();
export function parseReadWorkerStart(input: unknown): ReadWorkerStart {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  validateKubectlReadRequest(parsed.data.request); // The worker never accepts arbitrary argv or executables.
  return parsed.data;
}
export function parseReadWorkerResult(input: unknown, maximumBytes = 2_000_000): ReadWorkerResult {
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success || ![2_000_000, 8_000_000].includes(maximumBytes) || (parsed.data.ok && parsed.data.body.byteLength > maximumBytes)) throw new BoundaryError('STATE_UNAVAILABLE');
  return parsed.data;
}
export function readWorkerFailure(error: unknown): ReadWorkerResult {
  const code = error instanceof BoundaryError && failureCodes.some(code => code === error.code) ? error.code : 'STATE_UNAVAILABLE';
  return parseReadWorkerResult({ protocol: 1, ok: false, code });
}

// Pure read-only lifecycle; no callback, process, timer, filesystem or cleanup is run here.
// A stop wins over late startup/results; the IPC channel is not a reconnectable lease.
export function createReadWorkerState() {
  let phase: 'waiting' | 'running' | 'stopping' | 'closed' = 'waiting';
  let failure: 'QUERY_CANCELLED' | 'QUERY_TIMEOUT' | 'INVALID_INPUT' | undefined;
  return {
    start(): boolean { if (phase !== 'waiting') return false; phase = 'running'; return true; },
    stop(code: 'QUERY_CANCELLED' | 'QUERY_TIMEOUT' | 'INVALID_INPUT'): boolean {
      if (phase === 'closed' || phase === 'stopping') return false;
      failure = code; phase = 'stopping'; return true;
    },
    close() { phase = 'closed'; },
    get phase() { return phase; }, get failure() { return failure; },
  };
}
