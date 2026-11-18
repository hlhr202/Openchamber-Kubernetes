import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { ReadResponse } from './bounded-response.ts';
import type { ResourceReadRequest } from './resource-reader.ts';
import type { ReadPriority } from './read-scheduler.ts';

export type OutboundReadGateLimits = {
  readonly concurrency: number;
  readonly tokensPerSecond: number;
  readonly burst: number;
  readonly queued: number;
  readonly timeoutMs: number;
  readonly backgroundMaxSlots: number;
  readonly monotonicNow?: () => number;
};

export const frozenRxReadLimits: Readonly<OutboundReadGateLimits> = Object.freeze({
  concurrency: 2,
  tokensPerSecond: 2,
  burst: 2,
  queued: 16,
  timeoutMs: 12_000,
  backgroundMaxSlots: 1,
});

export type SanitizedReadIntentRecord = {
  readonly at: number;
  readonly kind: string;
  readonly purpose: ResourceReadRequest['purpose'];
  readonly priority: ReadPriority;
  readonly outcome: 'ok' | 'limit' | 'timeout' | 'cancelled' | 'auth' | 'rate-limited' | 'error';
  readonly status?: number;
  readonly queueWaitMs: number;
  readonly durationMs: number;
  readonly bytes: number;
};

export type OutboundReadDiagnostics = {
  readonly limits: Readonly<Omit<OutboundReadGateLimits, 'monotonicNow'>>;
  readonly inFlight: number;
  readonly inFlightBackground: number;
  readonly queued: number;
  readonly tokensAvailable: number;
  readonly logicalIntents: number;
  readonly transportCalls: number;
  readonly observableHttpRequests: number;
  readonly coalescedLogical: number;
  readonly queueWaits: number;
  readonly totalQueueWaitMs: number;
  readonly totalDurationMs: number;
  readonly responseBytes: number;
  readonly cancelledQueued: number;
  readonly cancelledRunning: number;
  readonly rejectedLimit: number;
  readonly rejectedCooldown: number;
  readonly timedOut: number;
  readonly rateDelayed: number;
  readonly status401: number;
  readonly status403: number;
  readonly status410: number;
  readonly status429: number;
  readonly retryAfterObserved: number;
  readonly activeCooldowns: number;
  readonly recent: readonly SanitizedReadIntentRecord[];
};

type QueuedAdmission = {
  readonly priority: ReadPriority;
  readonly intentKind: string;
  readonly purpose: ResourceReadRequest['purpose'];
  readonly clusterKey: string;
  readonly enqueuedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly start: () => void;
  readonly fail: (error: BoundaryError) => void;
  readonly cleanup: () => void;
  settled: boolean;
};

type ContextScope = { readonly priority: ReadPriority; readonly intentKind: string };

// Service-shared outbound cluster read admission gate (RX-D1 / RX-C4 / RX-C5 / RX-C10).
// Enforces a single global concurrency/rate/queue/deadline pool across all tabs/panels/aliases,
// while tracking Retry-After cooldowns per server-derived cluster partition.
export function createOutboundReadGate(
  transport: (selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal) => Promise<ReadResponse>,
  overrides: Partial<OutboundReadGateLimits> = {},
) {
  const limits: OutboundReadGateLimits = { ...frozenRxReadLimits, ...overrides };
  const now = limits.monotonicNow ?? (() => performance.now());
  const context = new AsyncLocalStorage<ContextScope>();
  const queue: QueuedAdmission[] = [];
  const cooldowns = new Map<string, number>();
  let running = 0;
  let runningBackground = 0;
  let tokens = limits.burst;
  let lastRefillAt = now();
  let rateTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const counters = {
    logicalIntents: 0,
    transportCalls: 0,
    observableHttpRequests: 0,
    coalescedLogical: 0,
    queueWaits: 0,
    totalQueueWaitMs: 0,
    totalDurationMs: 0,
    responseBytes: 0,
    cancelledQueued: 0,
    cancelledRunning: 0,
    rejectedLimit: 0,
    rejectedCooldown: 0,
    timedOut: 0,
    rateDelayed: 0,
    status401: 0,
    status403: 0,
    status410: 0,
    status429: 0,
    retryAfterObserved: 0,
  };
  const recent: SanitizedReadIntentRecord[] = [];

  function pushRecent(entry: SanitizedReadIntentRecord): void {
    recent.push(entry);
    if (recent.length > 32) recent.shift();
  }

  function partitionKey(selection: ConfigSelection, request: ResourceReadRequest): string {
    return createHash('sha256').update(JSON.stringify([selection, request.target.configIdentity, request.target.context])).digest('hex');
  }

  function refillTokens(): void {
    const current = now();
    if (current > lastRefillAt) {
      tokens = Math.min(limits.burst, tokens + ((current - lastRefillAt) / 1000) * limits.tokensPerSecond);
      lastRefillAt = current;
    }
  }

  function scheduleRateWake(): void {
    if (closed || rateTimer || !queue.length) return;
    refillTokens();
    if (tokens >= 1) return;
    const waitMs = Math.max(1, Math.ceil(((1 - tokens) / limits.tokensPerSecond) * 1000));
    counters.rateDelayed++;
    rateTimer = setTimeout(() => {
      rateTimer = undefined;
      pump();
    }, waitMs);
  }

  function nextIndex(): number {
    const manualIndex = queue.findIndex(item => !item.settled && item.priority === 'manual');
    if (manualIndex !== -1) return manualIndex;
    if (runningBackground < limits.backgroundMaxSlots) {
      return queue.findIndex(item => !item.settled);
    }
    return -1;
  }

  function sweepExpired(current: number): void {
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      if (!item || item.settled) continue;
      if (current >= item.deadlineAt) {
        queue.splice(i, 1);
        item.settled = true;
        item.cleanup();
        counters.timedOut++;
        pushRecent({
          at: Date.now(), kind: item.intentKind, purpose: item.purpose, priority: item.priority,
          outcome: 'timeout', queueWaitMs: Math.max(0, Math.round(current - item.enqueuedAt)), durationMs: 0, bytes: 0,
        });
        item.fail(new BoundaryError('QUERY_TIMEOUT'));
      }
    }
  }

  function pump(): void {
    if (closed) return;
    const current = now();
    sweepExpired(current);
    while (!closed && running < limits.concurrency && queue.length) {
      const index = nextIndex();
      if (index === -1) break;
      refillTokens();
      if (tokens < 1) {
        scheduleRateWake();
        break;
      }
      const [item] = queue.splice(index, 1);
      if (!item || item.settled) continue;
      const cooldownUntil = cooldowns.get(item.clusterKey);
      if (cooldownUntil !== undefined && current < cooldownUntil) {
        item.settled = true;
        item.cleanup();
        counters.rejectedCooldown++;
        item.fail(new BoundaryError('QUERY_LIMIT'));
        continue;
      }
      if (cooldownUntil !== undefined && current >= cooldownUntil) cooldowns.delete(item.clusterKey);
      tokens -= 1;
      item.settled = true;
      item.cleanup();
      const waitMs = Math.max(0, Math.round(current - item.enqueuedAt));
      if (waitMs > 0) {
        counters.queueWaits++;
        counters.totalQueueWaitMs += waitMs;
      }
      item.start();
    }
  }

  function wrapResponse(
    raw: ReadResponse,
    meta: { readonly startedAt: number; readonly queueWaitMs: number; readonly priority: ReadPriority; readonly intentKind: string; readonly purpose: ResourceReadRequest['purpose']; readonly clusterKey: string },
    onSettled: () => void,
  ): ReadResponse {
    let settled = false;
    let bytes = 0;
    const settle = (outcome: SanitizedReadIntentRecord['outcome']) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.max(0, Math.round(now() - meta.startedAt));
      counters.totalDurationMs += durationMs;
      counters.responseBytes += bytes;
      pushRecent({
        at: Date.now(), kind: meta.intentKind, purpose: meta.purpose, priority: meta.priority,
        outcome, status: raw.status, queueWaitMs: meta.queueWaitMs, durationMs, bytes,
      });
      onSettled();
    };

    if (raw.status === 401) counters.status401++;
    else if (raw.status === 403) counters.status403++;
    else if (raw.status === 410) counters.status410++;
    else if (raw.status === 429) {
      counters.status429++;
      if (typeof raw.retryAfterMs === 'number' && Number.isFinite(raw.retryAfterMs) && raw.retryAfterMs > 0) {
        counters.retryAfterObserved++;
        cooldowns.set(meta.clusterKey, now() + Math.min(60_000, raw.retryAfterMs));
      }
    }

    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of raw.body) {
            bytes += chunk.byteLength;
            yield chunk;
          }
        } catch (error) {
          settle('error');
          throw error;
        }
      },
    };
    const close = async () => {
      try {
        await raw.close();
      } finally {
        const outcome: SanitizedReadIntentRecord['outcome'] = raw.status === 200 ? 'ok'
          : raw.status === 401 || raw.status === 403 ? 'auth'
          : raw.status === 429 ? 'rate-limited' : 'error';
        settle(outcome);
      }
    };
    return { status: raw.status, ...(raw.retryAfterMs !== undefined ? { retryAfterMs: raw.retryAfterMs } : {}), body, close };
  }

  async function acquireSlot(
    clusterKey: string,
    priority: ReadPriority,
    intentKind: string,
    purpose: ResourceReadRequest['purpose'],
    signal: AbortSignal,
  ): Promise<{ readonly queueWaitMs: number; readonly release: () => void }> {
    if (closed) throw new BoundaryError('SERVICE_CLOSED');
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    const enqueuedAt = now();
    const cooldownUntil = cooldowns.get(clusterKey);
    if (cooldownUntil !== undefined) {
      if (enqueuedAt < cooldownUntil) {
        counters.rejectedCooldown++;
        throw new BoundaryError('QUERY_LIMIT');
      }
      cooldowns.delete(clusterKey);
    }
    const deadlineAt = enqueuedAt + limits.timeoutMs;
    if (queue.length >= limits.queued) {
      counters.rejectedLimit++;
      throw new BoundaryError('QUERY_LIMIT');
    }

    return new Promise<{ readonly queueWaitMs: number; readonly release: () => void }>((resolve, reject) => {
      let item: QueuedAdmission;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (item.settled) return;
        item.settled = true;
        const index = queue.indexOf(item);
        if (index !== -1) queue.splice(index, 1);
        item.cleanup();
        counters.cancelledQueued++;
        pushRecent({
          at: Date.now(), kind: intentKind, purpose, priority, outcome: 'cancelled',
          queueWaitMs: Math.max(0, Math.round(now() - enqueuedAt)), durationMs: 0, bytes: 0,
        });
        reject(new BoundaryError('QUERY_CANCELLED'));
      };
      const onTimeout = () => {
        if (item.settled) return;
        item.settled = true;
        const index = queue.indexOf(item);
        if (index !== -1) queue.splice(index, 1);
        item.cleanup();
        counters.timedOut++;
        pushRecent({
          at: Date.now(), kind: intentKind, purpose, priority, outcome: 'timeout',
          queueWaitMs: Math.max(0, Math.round(now() - enqueuedAt)), durationMs: 0, bytes: 0,
        });
        reject(new BoundaryError('QUERY_TIMEOUT'));
      };
      item = {
        priority,
        intentKind,
        purpose,
        clusterKey,
        enqueuedAt,
        deadlineAt,
        signal,
        settled: false,
        cleanup: () => {
          signal.removeEventListener('abort', onAbort);
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
        },
        fail: error => reject(error),
        start: () => {
          const queueWaitMs = Math.max(0, Math.round(now() - enqueuedAt));
          running++;
          if (priority === 'background') runningBackground++;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            running--;
            if (priority === 'background') runningBackground--;
            pump();
          };
          resolve({ queueWaitMs, release });
        },
      };
      timeoutTimer = setTimeout(onTimeout, limits.timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(item);
      pump();
    });
  }

  return {
    recordLogicalIntent(coalesced = false): void {
      counters.logicalIntents++;
      if (coalesced) counters.coalescedLogical++;
    },
    withScope<R>(scope: Partial<ContextScope>, fn: () => R): R {
      const parent = context.getStore();
      return context.run({ priority: scope.priority ?? parent?.priority ?? 'manual', intentKind: scope.intentKind ?? parent?.intentKind ?? 'read' }, fn);
    },
    async admit(selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal): Promise<ReadResponse> {
      const scope = context.getStore();
      const priority: ReadPriority = scope?.priority ?? 'manual';
      const intentKind = scope?.intentKind ?? request.purpose;
      const clusterKey = partitionKey(selection, request);
      const { queueWaitMs, release } = await acquireSlot(clusterKey, priority, intentKind, request.purpose, signal);
      const startedAt = now();
      counters.transportCalls++;
      counters.observableHttpRequests++;
      let handedOff = false;
      const onAbort = () => { if (!handedOff) counters.cancelledRunning++; };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const raw = await transport(selection, request, signal);
        handedOff = true;
        signal.removeEventListener('abort', onAbort);
        return wrapResponse(raw, { startedAt, queueWaitMs, priority, intentKind, purpose: request.purpose, clusterKey }, release);
      } catch (error) {
        signal.removeEventListener('abort', onAbort);
        const durationMs = Math.max(0, Math.round(now() - startedAt));
        counters.totalDurationMs += durationMs;
        const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
        if (code === 'QUERY_CANCELLED') counters.cancelledRunning++;
        else if (code === 'QUERY_TIMEOUT') counters.timedOut++;
        else if (code === 'UNAUTHENTICATED') counters.status401++;
        else if (code === 'FORBIDDEN') counters.status403++;
        else if (code === 'CONTINUATION_EXPIRED') counters.status410++;
        else if (code === 'QUERY_LIMIT') counters.status429++;
        pushRecent({
          at: Date.now(), kind: intentKind, purpose: request.purpose, priority,
          outcome: code === 'QUERY_CANCELLED' ? 'cancelled' : code === 'QUERY_TIMEOUT' ? 'timeout'
            : code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' ? 'auth'
            : code === 'QUERY_LIMIT' ? 'rate-limited' : 'error',
          queueWaitMs, durationMs, bytes: 0,
        });
        release();
        throw error;
      }
    },
    // Gates long-lived Watch/Follow connection/relist handshake starts without holding finite GET slots for idle stream lifetime.
    async admitStreamStart(selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal): Promise<void> {
      const scope = context.getStore();
      const priority: ReadPriority = scope?.priority ?? 'manual';
      const intentKind = scope?.intentKind ?? 'stream-open';
      const clusterKey = partitionKey(selection, request);
      const { queueWaitMs, release } = await acquireSlot(clusterKey, priority, intentKind, request.purpose, signal);
      counters.transportCalls++;
      counters.observableHttpRequests++;
      pushRecent({
        at: Date.now(), kind: intentKind, purpose: request.purpose, priority,
        outcome: 'ok', queueWaitMs, durationMs: 0, bytes: 0,
      });
      release();
    },
    diagnostics(): OutboundReadDiagnostics {
      refillTokens();
      const current = now();
      let activeCooldowns = 0;
      for (const until of cooldowns.values()) if (until > current) activeCooldowns++;
      return Object.freeze({
        limits: Object.freeze({
          concurrency: limits.concurrency,
          tokensPerSecond: limits.tokensPerSecond,
          burst: limits.burst,
          queued: limits.queued,
          timeoutMs: limits.timeoutMs,
          backgroundMaxSlots: limits.backgroundMaxSlots,
        }),
        inFlight: running,
        inFlightBackground: runningBackground,
        queued: queue.length,
        tokensAvailable: Math.floor(tokens * 100) / 100,
        activeCooldowns,
        ...counters,
        recent: Object.freeze([...recent]),
      });
    },
    close(): void {
      closed = true;
      if (rateTimer) { clearTimeout(rateTimer); rateTimer = undefined; }
      for (const item of queue.splice(0)) {
        if (item.settled) continue;
        item.settled = true;
        item.cleanup();
        item.fail(new BoundaryError('SERVICE_CLOSED'));
      }
      cooldowns.clear();
    },
  };
}
