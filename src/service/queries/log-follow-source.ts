import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, namespaceName } from '../../shared/identity.ts';
import { logFollowSourceSchema } from '../../shared/log-follow-protocol.ts';
import type { LogFollowSource, LogFollowEvent } from '../../shared/log-follow-protocol.ts';
import { projectLogContainers, planPodLogReference } from './pod-log-source.ts';
import { jobLogMembership } from './job-log-source.ts';
import type { ResourceReadRequest } from './resource-reader.ts';

const rv = z.object({ metadata: z.object({ resourceVersion: boundedName }) });
export function logFollowProof(pod: unknown, job: unknown, source: LogFollowSource, initial: boolean): string {
  const version = rv.safeParse(pod); if (!version.success) throw new BoundaryError('RESOURCE_INVALID');
  const reference = { ...source.reference, resourceVersion: initial ? source.reference.resourceVersion : version.data.metadata.resourceVersion };
  const selected = projectLogContainers(pod, reference).find(item => item.name === source.container); if (!selected) throw new BoundaryError('NOT_FOUND');
  const data = z.object({ status: z.object({ initContainerStatuses: z.array(z.unknown()).max(128).optional(), containerStatuses: z.array(z.unknown()).max(128).optional() }) }).safeParse(pod);
  if (!data.success) throw new BoundaryError('STATE_UNAVAILABLE');
  const statuses = selected.kind === 'init' ? data.data.status.initContainerStatuses : data.data.status.containerStatuses;
  const statusSchema = z.object({ name: namespaceName, containerID: boundedName.optional(), restartCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.object({ running: z.object({}).optional(), terminated: z.object({ containerID: boundedName.optional() }).optional() }) });
  const parsed = (statuses ?? []).map(value => statusSchema.safeParse(value)); if (parsed.some(value => !value.success)) throw new BoundaryError('RESOURCE_INVALID');
  const matches = parsed.flatMap(value => value.success && value.data.name === source.container ? [value.data] : []), status = matches[0];
  if (matches.length !== 1 || !status || (!status.state.running && !status.state.terminated)) throw new BoundaryError('STATE_UNAVAILABLE');
  const id = status.containerID ?? status.state.terminated?.containerID; if (!id) throw new BoundaryError('STATE_UNAVAILABLE');
  let membership = '';
  if (source.origin) {
    const current = rv.safeParse(job); if (!current.success) throw new BoundaryError('RESOURCE_INVALID');
    membership = jobLogMembership(job, pod, source.target, { ...source.origin, resourceVersion: initial ? source.origin.resourceVersion : current.data.metadata.resourceVersion }, reference);
  }
  // Allow same UID RV/status changes and running→terminated, never a restart/new container/Job selector drift.
  return JSON.stringify([selected, id, status.restartCount, membership]);
}
export function planLogFollow(input: unknown): ResourceReadRequest {
  const parsed = logFollowSourceSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const source = parsed.data, plan = planPodLogReference(source.reference, source.target), query: Record<string, string> = { container: source.container, timestamps: String(source.options.timestamps), follow: 'true' };
  if (source.options.sinceSeconds !== null) query.sinceSeconds = String(source.options.sinceSeconds);
  if (source.options.tailLines !== null) query.tailLines = String(source.options.tailLines);
  return { method: 'GET', purpose: 'pod-log-follow', target: source.target, path: `${plan.path}/log`, maximumBytes: 2_000_000, query };
}
export function createLogFollowDecoder(emit: (event: Omit<LogFollowEvent, 'sequence'>) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, chunks = 0, failed = false;
  function text(value: string) {
    for (let start = 0; start < value.length;) { let end = Math.min(start + 4096, value.length); const code = value.charCodeAt(end - 1); if (end < value.length && code >= 0xD800 && code <= 0xDBFF) end--;
      if (++chunks > 2048) throw new BoundaryError('BUDGET_EXCEEDED'); emit({ text: value.slice(start, end) }); start = end; }
  }
  return {
    push(value: Uint8Array) { if (failed) throw new BoundaryError('STATE_UNAVAILABLE'); try { if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED'); text(decoder.decode(value, { stream: true })); }
      catch (error) { failed = true; throw error instanceof BoundaryError ? error : new BoundaryError('CONTENT_INVALID'); } },
    finish() { if (failed) throw new BoundaryError('STATE_UNAVAILABLE'); try { text(decoder.decode()); } catch (error) { throw error instanceof BoundaryError ? error : new BoundaryError('CONTENT_INVALID'); } finally { failed = true; } },
  };
}
