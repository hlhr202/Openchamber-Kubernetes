import { z } from 'zod';
import { BoundaryError, errorCodes } from '../../shared/errors.ts';
import { containsControlCharacters, targetSchema } from '../../shared/identity.ts';
import { deleteParametersSchema } from '../../shared/delete-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import { planResourceDocument } from '../queries/resource-document.ts';
import { namespaceDeleteReferenceSchema } from '../../shared/namespace-inventory.ts';

export const deleteWorkerFlag = '--oc-k8s-delete-worker-v1';
export const deleteWorkerDeadlineMs = 8000;
const workerParameters = z.union([deleteParametersSchema, z.object({ reference: namespaceDeleteReferenceSchema, mode: z.literal('standard') }).strict()]);
const startSchema = z.object({ protocol: z.literal(1), kind: z.literal('delete'), target: targetSchema, parameters: workerParameters,
  snapshot: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 8_000_000),
  path: z.string().min(1).max(32_000).refine(value => !containsControlCharacters(value)), notAfter: z.number().int().nonnegative() }).strict();
export const deleteWorkerResultSchema = z.object({ protocol: z.literal(1), kind: z.literal('delete-result'), outcome: z.enum(['accepted', 'rejected', 'not-submitted', 'unknown']), code: z.enum(errorCodes).optional() }).strict();
export type DeleteWorkerResult = z.infer<typeof deleteWorkerResultSchema>;
export function parseDeleteWorkerStart(input: unknown) {
  const parsed = startSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  planResourceDocument(parsed.data.parameters.reference, parsed.data.target); return parsed.data;
}
export function deleteCommand(start: ReturnType<typeof parseDeleteWorkerStart>, fifo: string) {
  if (!fifo.startsWith('/') || fifo.startsWith('//') || containsControlCharacters(fifo)) throw new BoundaryError('INVALID_INPUT');
  const ref = start.parameters.reference;
  return { args: [`--kubeconfig=${fifo}`, `--context=${start.target.context}`, '--request-timeout=7s', '--profile=none', '--v=0', 'delete',
    `--raw=${resourceObjectPath(ref.type, ref.name, ref.namespace)}`, '-f', '-'],
  input: Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: ref.uid, resourceVersion: ref.resourceVersion }, propagationPolicy: 'Background',
    ...(start.parameters.mode === 'now' ? { gracePeriodSeconds: 1 } : {}) })) };
}
