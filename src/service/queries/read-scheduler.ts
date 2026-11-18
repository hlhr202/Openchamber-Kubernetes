import { getHeapStatistics } from 'node:v8';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import type { ErrorCode } from '../../shared/errors.ts';

type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BoundaryError };
type Consumer<T> = { readonly finish: (result: ReadResult<T>) => void };
export type ReadPriority = 'manual' | 'background';
type Job<T> = {
  readonly key: string;
  readonly controller: AbortController;
  readonly load: (signal: AbortSignal) => Promise<T>;
  readonly consumers: Set<Consumer<T>>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly deadlineAt: number;
  priority: ReadPriority;
  state: 'queued' | 'running' | 'retired';
};
type RateLimit = { readonly tokensPerSecond: number; readonly burst: number };
type Limits = {
  concurrency: number;
  queued: number;
  consumers: number;
  timeoutMs: number;
  rate?: RateLimit;
  backgroundMaxSlots?: number;
  monotonicNow?: () => number;
  heapPressure?: () => { usedBytes: number; limitBytes: number };
};

// Default process-level heap watermark probe (v8). Overridable only for reviewed tests.
const defaultHeapPressure = () => { const stats = getHeapStatistics(); return { usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit }; };
const heapWatermarkFraction = 0.9;

// Only for reviewed, cancellable READS. No retries, result cache, persistence or operation hooks.
// The generic is per scheduler, so sharing a key cannot cast a result to a different DTO type.
// A new consumer is refused with QUERY_LIMIT while the process heap sits above the hard watermark.
export class ReadScheduler<T> {
  readonly #limits: Readonly<Limits>;
  readonly #now: () => number;
  readonly #jobs = new Map<string, Job<T>>();
  readonly #queue: Job<T>[] = [];
  readonly #running = new Set<Job<T>>();
  #tokens: number;
  #lastRefillAt: number;
  #rateTimer: ReturnType<typeof setTimeout> | undefined;
  #consumerCount = 0;
  #started = 0;
  #completed = 0;
  #coalesced = 0;
  #cancelledQueued = 0;
  #cancelledRunning = 0;
  #rejectedLimit = 0;
  #timedOut = 0;
  #rateDelayed = 0;
  #closed = false;

  constructor(limits: Limits) {
    if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1 || limits.concurrency > 64
      || !Number.isInteger(limits.queued) || limits.queued < 0 || limits.queued > 1024
      || !Number.isInteger(limits.consumers) || limits.consumers < 1 || limits.consumers > 4096
      || !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 60_000) throw new BoundaryError('INVALID_INPUT');
    if (limits.rate && (!Number.isFinite(limits.rate.tokensPerSecond) || limits.rate.tokensPerSecond <= 0 || limits.rate.tokensPerSecond > 1000
      || !Number.isInteger(limits.rate.burst) || limits.rate.burst < 1 || limits.rate.burst > 1000)) throw new BoundaryError('INVALID_INPUT');
    if (limits.backgroundMaxSlots !== undefined && (!Number.isInteger(limits.backgroundMaxSlots) || limits.backgroundMaxSlots < 0 || limits.backgroundMaxSlots > limits.concurrency)) {
      throw new BoundaryError('INVALID_INPUT');
    }
    this.#limits = Object.freeze({ ...limits, ...(limits.rate ? { rate: Object.freeze({ ...limits.rate }) } : {}) });
    this.#now = limits.monotonicNow ?? (() => performance.now());
    this.#tokens = limits.rate ? limits.rate.burst : Number.POSITIVE_INFINITY;
    this.#lastRefillAt = this.#now();
  }

  run(keyParts: readonly string[], load: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number; priority?: ReadPriority } = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new BoundaryError('SERVICE_CLOSED'));
    if (!keyParts.length || keyParts.length > 32 || keyParts.some(part => !boundedName.safeParse(part).success)) return Promise.reject(new BoundaryError('INVALID_INPUT'));
    if (options.signal?.aborted) return Promise.reject(new BoundaryError('QUERY_CANCELLED'));
    const priority: ReadPriority = options.priority ?? 'manual';
    if (priority !== 'manual' && priority !== 'background') return Promise.reject(new BoundaryError('INVALID_INPUT'));
    // Hard heap watermark: never admit NEW work while the process is above 90% of the heap limit.
    const heap = (this.#limits.heapPressure ?? defaultHeapPressure)();
    if (heap.limitBytes > 0 && heap.usedBytes > heapWatermarkFraction * heap.limitBytes) { this.#rejectedLimit++; return Promise.reject(new BoundaryError('QUERY_LIMIT')); }
    const timeout = options.timeoutMs ?? this.#limits.timeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > this.#limits.timeoutMs) return Promise.reject(new BoundaryError('INVALID_INPUT'));
    if (this.#consumerCount >= this.#limits.consumers) { this.#rejectedLimit++; return Promise.reject(new BoundaryError('QUERY_LIMIT')); }
    const key = JSON.stringify(keyParts);
    let job = this.#jobs.get(key);
    if (!job) {
      if (this.#running.size >= this.#limits.concurrency && this.#queue.length >= this.#limits.queued) { this.#rejectedLimit++; return Promise.reject(new BoundaryError('QUERY_LIMIT')); }
      if (!this.#limits.rate && this.#queue.length >= this.#limits.queued && this.#running.size >= this.#limits.concurrency) { this.#rejectedLimit++; return Promise.reject(new BoundaryError('QUERY_LIMIT')); }
      if (this.#limits.queued === 0 && this.#queue.length === 0 && (this.#running.size >= this.#limits.concurrency || !this.#hasTokenNow())) {
        if (this.#running.size >= this.#limits.concurrency) { this.#rejectedLimit++; return Promise.reject(new BoundaryError('QUERY_LIMIT')); }
      }
      if (this.#queue.length >= this.#limits.queued && (this.#running.size >= this.#limits.concurrency || !this.#hasTokenNow())) {
        this.#rejectedLimit++;
        return Promise.reject(new BoundaryError('QUERY_LIMIT'));
      }
      const controller = new AbortController();
      const deadlineAt = this.#now() + this.#limits.timeoutMs;
      const timer = setTimeout(() => { if (job) this.#retire(job, 'QUERY_TIMEOUT'); }, this.#limits.timeoutMs);
      job = { key, controller, load, consumers: new Set(), timer, deadlineAt, priority, state: 'queued' };
      this.#jobs.set(key, job);
      this.#queue.push(job);
    } else {
      this.#coalesced++;
      if (priority === 'manual' && job.priority === 'background') job.priority = 'manual';
    }
    const currentJob = job;
    const promise = new Promise<T>((resolve, reject) => {
      let finished = false;
      const signal = options.signal;
      const cancel = () => consumer.finish({ ok: false, error: new BoundaryError('QUERY_CANCELLED') });
      const timer = setTimeout(() => consumer.finish({ ok: false, error: new BoundaryError('QUERY_TIMEOUT') }), timeout);
      const consumer: Consumer<T> = {
        finish: result => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          currentJob.consumers.delete(consumer);
          this.#consumerCount--;
          if (result.ok) resolve(result.value);
          else reject(result.error);
          if (currentJob.consumers.size === 0 && currentJob.state !== 'retired') this.#retire(currentJob, 'QUERY_CANCELLED');
        },
      };
      currentJob.consumers.add(consumer);
      this.#consumerCount++;
      signal?.addEventListener('abort', cancel, { once: true });
    });
    this.#pump();
    return promise;
  }

  #refillTokens(): void {
    const rate = this.#limits.rate;
    if (!rate) return;
    const now = this.#now();
    if (now > this.#lastRefillAt) {
      this.#tokens = Math.min(rate.burst, this.#tokens + ((now - this.#lastRefillAt) / 1000) * rate.tokensPerSecond);
      this.#lastRefillAt = now;
    }
  }

  #hasTokenNow(): boolean {
    if (!this.#limits.rate) return true;
    this.#refillTokens();
    return this.#tokens >= 1;
  }

  #scheduleRateWake(): void {
    const rate = this.#limits.rate;
    if (!rate || this.#closed || this.#rateTimer || !this.#queue.length) return;
    this.#refillTokens();
    if (this.#tokens >= 1) return;
    const missing = 1 - this.#tokens;
    const waitMs = Math.max(1, Math.ceil((missing / rate.tokensPerSecond) * 1000));
    this.#rateDelayed++;
    this.#rateTimer = setTimeout(() => {
      this.#rateTimer = undefined;
      this.#pump();
    }, waitMs);
  }

  #retire(job: Job<T>, code: ErrorCode): void {
    if (job.state === 'retired') return;
    const previousState = job.state;
    job.state = 'retired';
    clearTimeout(job.timer);
    if (code === 'QUERY_TIMEOUT') this.#timedOut++;
    else if (code === 'QUERY_CANCELLED') {
      if (previousState === 'queued') this.#cancelledQueued++;
      else if (previousState === 'running') this.#cancelledRunning++;
    }
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex !== -1) this.#queue.splice(queuedIndex, 1);
    for (const consumer of job.consumers) consumer.finish({ ok: false, error: new BoundaryError(code) });
    job.controller.abort();
    // A non-cooperating read STILL occupies its running slot until actually settled.
    this.#pump();
  }

  #nextRunnableIndex(): number {
    const bgLimit = this.#limits.backgroundMaxSlots;
    let runningBg = 0;
    if (bgLimit !== undefined) {
      for (const job of this.#running) if (job.priority === 'background') runningBg++;
    }
    const manualIndex = this.#queue.findIndex(job => job.state === 'queued' && job.priority === 'manual');
    if (manualIndex !== -1) return manualIndex;
    if (bgLimit === undefined || runningBg < bgLimit) {
      return this.#queue.findIndex(job => job.state === 'queued');
    }
    return -1;
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#limits.concurrency && this.#queue.length) {
      const now = this.#now();
      // Retire expired queued jobs before admitting any start.
      let expired = false;
      for (const queued of Array.from(this.#queue)) {
        if (now >= queued.deadlineAt) { this.#retire(queued, 'QUERY_TIMEOUT'); expired = true; }
      }
      if (expired && !this.#queue.length) break;
      const index = this.#nextRunnableIndex();
      if (index === -1) break;
      if (this.#limits.rate) {
        this.#refillTokens();
        if (this.#tokens < 1) { this.#scheduleRateWake(); break; }
      }
      const [job] = this.#queue.splice(index, 1);
      if (!job || job.state !== 'queued') continue;
      if (this.#limits.rate) this.#tokens -= 1;
      job.state = 'running';
      this.#running.add(job);
      this.#started++;
      void Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        return job.load(job.controller.signal);
      }).then(value => {
        if (job.state === 'retired') return;
        job.state = 'retired';
        this.#completed++;
        if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
        for (const consumer of job.consumers) consumer.finish({ ok: true, value });
      }, error => {
        this.#retire(job, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
      }).finally(() => {
        clearTimeout(job.timer);
        if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
        this.#running.delete(job);
        this.#pump();
      });
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#rateTimer) { clearTimeout(this.#rateTimer); this.#rateTimer = undefined; }
    for (const job of Array.from(this.#jobs.values())) this.#retire(job, 'SERVICE_CLOSED');
  }

  // Counts only. Never expose query keys, data, callback errors or abort reasons to diagnostics.
  get state() { return { closed: this.#closed, running: this.#running.size, queued: this.#queue.length, consumers: this.#consumerCount }; }
  get stats() {
    return Object.freeze({
      closed: this.#closed, running: this.#running.size, queued: this.#queue.length, consumers: this.#consumerCount,
      started: this.#started, completed: this.#completed, coalesced: this.#coalesced,
      cancelledQueued: this.#cancelledQueued, cancelledRunning: this.#cancelledRunning,
      rejectedLimit: this.#rejectedLimit, timedOut: this.#timedOut, rateDelayed: this.#rateDelayed,
    });
  }
}
