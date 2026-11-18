import { createHash } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { openApiSchemaBytes } from '../../shared/explain-protocol.ts';
import type { ExplainRequest } from '../../shared/explain-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ResourceReadRequest, ResourceReadTransport } from './resource-reader.ts';
import { readResponseText } from './bounded-response.ts';
import { customDocumentProof } from './custom-document.ts';
import { apiDiscoveryPath } from './resource-query.ts';
import { crdType, resourceObjectPath } from './parent-resource.ts';
import { openApiLocation, projectExplanation } from './openapi-explanation.ts';

// Schema-only proof in the caller's existing finite slot. No instance body, nested scheduling, cache or fallback.
export async function readCustomExplanation(input: ExplainRequest, signal: AbortSignal, read: ResourceReadTransport,
  verify: (target: TargetIdentity, signal: AbortSignal) => Promise<void>) {
  const { target, type, definition } = input;
  if (!definition) throw new BoundaryError('INVALID_INPUT');
  let reads = 0, bytes = 0;
  const get = async (purpose: ResourceReadRequest['purpose'], path: string, query: Readonly<Record<string, string>> = {}) => {
    await verify(target, signal);
    if (++reads > 7 || bytes >= 16_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const maximumBytes = purpose === 'openapi-schema' ? openApiSchemaBytes : 2_000_000;
    const text = await readResponseText(await read({ method: 'GET', purpose, target, path, query, maximumBytes }, signal), signal, Math.min(maximumBytes, 16_000_000 - bytes));
    bytes += Buffer.byteLength(text); await verify(target, signal);
    try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
  };
  const proof = async () => customDocumentProof(await get('resource-object', resourceObjectPath(crdType, definition.name)),
    await get('api-version', apiDiscoveryPath(type.group, type.version)), { type, definition });
  const original = await proof(), before = openApiLocation(await get('openapi-index', '/openapi/v3'), type);
  const schema = await get('openapi-schema', before.path, before.query), explanation = projectExplanation(schema, input);
  if (openApiLocation(await get('openapi-index', '/openapi/v3'), type).identity !== before.identity || await proof() !== original) throw new BoundaryError('STALE_TARGET');
  await verify(target, signal);
  return { explanation, schemaIdentity: createHash('sha256').update(JSON.stringify([original, before.identity])).digest('hex') };
}
