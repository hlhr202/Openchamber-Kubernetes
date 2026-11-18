import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, dnsName, namespaceName } from '../../shared/identity.ts';
import { watchSourceSchema } from '../../shared/watch-protocol.ts';
import type { WatchSource, WatchEvent } from '../../shared/watch-protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { apiDiscoveryPath, requireReadSuccess } from './resource-query.ts';
import type { ResourceReadRequest } from './resource-reader.ts';

export function watchResourceType(source: WatchSource) {
  const type = source.custom?.type ?? Object.entries(resourceDescriptors).find(([key]) => key === source.resource)?.[1];
  if (!type) throw new BoundaryError('INVALID_INPUT'); return type;
}

export function planResourceWatch(input: unknown): ResourceReadRequest {
  const parsed = watchSourceSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const source = parsed.data, type = watchResourceType(source);
  if (source.resourceVersion === '0') throw new BoundaryError('INVALID_INPUT');
  const path = `${apiDiscoveryPath(type.group, type.version)}${type.scope === 'namespace' ? `/namespaces/${source.target.namespace}` : ''}/${type.resource}`;
  return { method: 'GET', purpose: source.custom ? 'custom-resource-watch' : 'resource-watch', target: source.target, path, maximumBytes: 2_000_000,
    ...(source.custom ? { customWatch: source.custom } : {}),
    query: { watch: 'true', resourceVersion: source.resourceVersion, timeoutSeconds: '5', ...(source.object ? { fieldSelector: `metadata.name=${source.object.name}` } : {}) } };
}
const envelope = z.object({ type: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK', 'ERROR']), object: z.unknown() });
const metadata = z.object({ apiVersion: boundedName, kind: boundedName, metadata: z.object({ resourceVersion: boundedName, name: dnsName, uid: boundedName, namespace: namespaceName.optional() }) });
export function projectWatchEvent(value: unknown, source: WatchSource): Omit<WatchEvent, 'sequence'> {
  const parsed = envelope.safeParse(value); if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const event = parsed.data;
  if (event.type === 'ERROR') {
    const status = z.object({ kind: z.literal('Status'), code: z.number().int() }).safeParse(event.object);
    if (!status.success) throw new BoundaryError('RESOURCE_INVALID'); requireReadSuccess(status.data.code); throw new BoundaryError('RESOURCE_INVALID');
  }
  if (event.type === 'BOOKMARK') {
    const bookmark = z.object({ metadata: z.object({ resourceVersion: boundedName }) }).safeParse(event.object);
    if (!bookmark.success) throw new BoundaryError('RESOURCE_INVALID'); return { type: 'BOOKMARK', resourceVersion: bookmark.data.metadata.resourceVersion };
  }
  const data = metadata.safeParse(event.object), type = watchResourceType(source);
  if (!data.success || !type || data.data.kind !== type.kind || data.data.apiVersion !== (type.group ? `${type.group}/${type.version}` : type.version)) throw new BoundaryError('RESOURCE_INVALID');
  const meta = data.data.metadata;
  if ((type.scope === 'namespace' ? meta.namespace !== source.target.namespace : meta.namespace !== undefined)
    || (source.object && (source.object.name !== meta.name || source.object.uid !== meta.uid))) throw new BoundaryError('STALE_TARGET');
  return { type: event.type, resourceVersion: meta.resourceVersion, name: meta.name, uid: meta.uid };
}

// Incremental newline framing. Never retain/project raw objects, data, annotations, messages or error text.
export function createWatchDecoder(source: WatchSource, emit: (event: Omit<WatchEvent, 'sequence'>) => void) {
  return createWatchFrameDecoder(value => emit(projectWatchEvent(value, source)));
}
// Shared bounded NDJSON framing for explicit read-only API watch consumers.
export function createWatchFrameDecoder(emit: (value: unknown) => void) {
  let pending = Buffer.alloc(0), bytes = 0, frames = 0, failed = false;
  function line(value: Uint8Array) {
    if (!value.byteLength) return;
    if (++frames > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
    let data: unknown;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
    emit(data);
  }
  return {
    push(chunk: Uint8Array) {
      if (failed) throw new BoundaryError('STATE_UNAVAILABLE');
      try {
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        const input = Buffer.concat([pending, chunk]); let offset = 0;
        for (let i = 0; i < input.length; i++) if (input[i] === 10) {
          if (i - offset > 262_144) throw new BoundaryError('BUDGET_EXCEEDED'); line(input.subarray(offset, i)); offset = i + 1;
        }
        if (input.length - offset > 262_144) throw new BoundaryError('BUDGET_EXCEEDED'); pending = Buffer.from(input.subarray(offset));
      } catch (error) { failed = true; pending = Buffer.alloc(0); throw error; }
    },
    finish() { if (failed) throw new BoundaryError('STATE_UNAVAILABLE'); try { if (pending.length) line(pending); } finally { pending = Buffer.alloc(0); failed = true; } },
  };
}
