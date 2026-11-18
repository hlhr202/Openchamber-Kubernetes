// WRITE worker contracts; source/static review only, not executable automatic tests.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { BoundaryError, errorCodes } from '../../shared/errors.ts';
import { targetSchema, containsControlCharacters, boundedName } from '../../shared/identity.ts';
import { manifestComparisonReferenceSchema, manifestComparisonPath } from '../../shared/manifest-diff-protocol.ts';
import { inspectCreateObject, manifestCreateBytes } from '../../shared/manifest-create-payload.ts';
import { parseDocumentJson } from '../../shared/document-json.ts';
export const manifestCreateWorkerFlag = '--oc-k8s-manifest-create-worker-v1';
export const manifestCreateWorkerDeadlineMs = 8000;
const startSchema = z.object({ protocol: z.literal(1), kind: z.literal('manifest-create'), target: targetSchema, reference: manifestComparisonReferenceSchema, generated: z.boolean().optional(),
  body: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= manifestCreateBytes), digest: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 8_000_000),
  path: z.string().min(1).max(32_000).refine(value => !containsControlCharacters(value)), notAfter: z.number().int().nonnegative() }).strict();
export const createWorkerReadySchema = z.object({ protocol: z.literal(1), kind: z.literal('create-ready') }).strict();
export const createWorkerGoSchema = z.object({ protocol: z.literal(1), kind: z.literal('create-go') }).strict();
const common = { protocol: z.literal(1), kind: z.literal('create-result'), cleanup: z.enum(['none', 'manual-check']) };
export const createWorkerResultSchema = z.discriminatedUnion('phase', [
  z.object({ ...common, phase: z.literal('succeeded'), uid: boundedName, resourceVersion: boundedName, name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/).max(253).optional() }).strict()
    .refine(value => value.name === undefined || value.name.length > 0),
  z.object({ ...common, phase: z.enum(['not-submitted', 'unknown']), code: z.enum(errorCodes) }).strict(),
]);
export type CreateWorkerResult = z.infer<typeof createWorkerResultSchema>;
export function parseCreateWorkerStart(input: unknown) {
  const parsed = startSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const value = parsed.data;
  if (createHash('sha256').update(value.body).digest('hex') !== value.digest) throw new BoundaryError('CONTENT_INVALID');
  const item = inspectCreateObject(parseDocumentJson(new TextDecoder('utf-8', { fatal: true }).decode(value.body))), ref = value.reference;
  if ((item.generated === true) !== (value.generated === true)) throw new BoundaryError('STALE_TARGET'); // a generated create never masquerades as a named one
  if (item.locator.group !== ref.type.group || item.locator.version !== ref.type.version || item.locator.kind !== ref.type.kind || item.locator.name !== ref.name
    || (ref.type.scope === 'namespace' ? (item.locator.namespace ?? value.target.namespace) !== ref.namespace : item.locator.namespace !== undefined)) throw new BoundaryError('STALE_TARGET');
  return value;
}
export function manifestCreateCommand(start: ReturnType<typeof parseCreateWorkerStart>, fifo: string) {
  if (!fifo.startsWith('/') || fifo.startsWith('//') || containsControlCharacters(fifo)) throw new BoundaryError('INVALID_INPUT');
  const objectPath = manifestComparisonPath(start.reference), collection = objectPath.slice(0, objectPath.lastIndexOf('/'));
  return [`--kubeconfig=${fifo}`, `--context=${start.target.context}`, '--request-timeout=7s', '--profile=none', '--v=0', 'create',
    `--raw=${collection}?fieldManager=kubectl-create&fieldValidation=Strict`, '-f', '-'];
}
