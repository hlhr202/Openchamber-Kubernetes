import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { configPageSchema, protocolVersion } from '../../shared/protocol.ts';
import type { createConfigReader } from './config-source.ts';

export type ConfigRead = Awaited<ReturnType<ReturnType<typeof createConfigReader>['read']>>;
type ConfigPageQuery = { readonly offset: number; readonly limit: number; readonly configIdentity?: string };

export function parseConfigPageQuery(parameters: URLSearchParams): ConfigPageQuery {
  const keys = [...parameters.keys()];
  if (keys.length > 3 || new Set(keys).size !== keys.length || keys.some(key => !['offset', 'limit', 'configIdentity'].includes(key))) throw new BoundaryError('INVALID_INPUT');
  const offsetText = parameters.get('offset') ?? '0';
  const limitText = parameters.get('limit') ?? '100';
  const configIdentity = parameters.get('configIdentity');
  if (!/^\d{1,4}$/.test(offsetText) || !/^\d{1,3}$/.test(limitText)) throw new BoundaryError('INVALID_INPUT');
  const offset = Number(offsetText), limit = Number(limitText);
  if (limit < 1 || limit > 100 || offset > 5000 || (offset > 0 && !configIdentity)
    || (configIdentity !== null && !boundedName.safeParse(configIdentity).success)) throw new BoundaryError('INVALID_INPUT');
  return { offset, limit, ...(configIdentity !== null ? { configIdentity } : {}) };
}

export function projectConfigPage(result: ConfigRead, serviceGeneration: string, query: ConfigPageQuery, rows = result.snapshot.contexts) {
  const { status, snapshot } = result;
  if (query.configIdentity !== undefined && query.configIdentity !== snapshot.configIdentity) throw new BoundaryError('STALE_TARGET');
  if (query.offset > rows.length) throw new BoundaryError('INVALID_INPUT');
  const current = snapshot.contexts.find(context => context.active);
  // Each follow-up page proves the same content/source generation; never concatenate mixed snapshots.
  return configPageSchema.parse({
    protocol: protocolVersion, serviceGeneration, status,
    configIdentity: snapshot.configIdentity, currentContextMissing: snapshot.currentContextMissing, currentContext: snapshot.currentContext,
    currentContextInfo: current ? { name: current.name, namespace: current.namespace, available: current.available, authentication: current.authentication } : null,
    sources: result.sources,
    contexts: rows.slice(query.offset, query.offset + query.limit), total: rows.length,
    nextOffset: query.offset + query.limit < rows.length ? query.offset + query.limit : null,
  });
}
