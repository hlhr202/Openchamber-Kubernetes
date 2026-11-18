import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import { healthSchema } from '../shared/protocol.ts';
import { preferenceAppendRequestSchema, preferencePrefix, preferenceReplySchema } from '../shared/preference-protocol.ts';
import type { PreferenceAppendRequest } from '../shared/preference-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
export type PreferenceServiceTransport = (request: { method: 'GET' | 'POST'; path: string; body?: string }) => Promise<{ status: number; body: string }>;

// Contains WRITE append transport. Never imported/called by automatic functional tests.
export function createPreferenceTransport(request: PreferenceServiceTransport) {
  const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
  const decode = (body: string): unknown => { if (utf8ByteLength(body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED'); try { return JSON.parse(body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } };
  async function rpc<T extends { serviceGeneration: string }>(path: string, value: T) {
    const body = JSON.stringify(value); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const response = await request({ method: 'POST', path, body }), data = decode(response.body);
    if (response.status !== 200) { const parsed = failure.safeParse(data); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
    const result = preferenceReplySchema.safeParse(data); if (!result.success || result.data.serviceGeneration !== value.serviceGeneration) throw new BoundaryError('STALE_TARGET'); return result.data;
  }
  return {
    async generation() { const response = await request({ method: 'GET', path: '/health' }), result = healthSchema.safeParse(decode(response.body)); if (response.status !== 200 || !result.success) throw new BoundaryError('STATE_UNAVAILABLE'); return result.data.serviceGeneration; },
    async keys(serviceGeneration: string) { const value = await rpc('/v2/preferences/read', { protocol: 2, serviceGeneration, kind: 'keys' }); if (value.kind !== 'keys') throw new BoundaryError('STATE_UNAVAILABLE'); return value.keys; },
    async get(key: string, serviceGeneration: string) { if (!key.startsWith(preferencePrefix)) throw new BoundaryError('INVALID_INPUT'); const value = await rpc('/v2/preferences/read', { protocol: 2, serviceGeneration, kind: 'get', id: key.slice(preferencePrefix.length) }); if (value.kind !== 'get') throw new BoundaryError('STATE_UNAVAILABLE'); return value.revision ?? undefined; },
    async append(input: PreferenceAppendRequest) { const parsed = preferenceAppendRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const value = await rpc('/v2/preferences/append', parsed.data); if (value.kind !== 'stored' || value.id !== parsed.data.revision.id) throw new BoundaryError('OPERATION_UNKNOWN'); },
  };
}
