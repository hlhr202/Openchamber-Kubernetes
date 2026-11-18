export type TreeRefreshResult = { readonly phase: 'ready'; readonly children: readonly string[] } | { readonly phase: 'error' | 'obsolete' };
export type TreeRefreshSchedule = (callback: () => void) => () => void;
export type TreeRefreshDelaySchedule = (callback: () => void, delayMs: number) => () => void;
export type TreeRefreshQueueOptions = {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly scheduleDelay?: TreeRefreshDelaySchedule;
  readonly canRun?: (id: string) => boolean;
};
const schedule: TreeRefreshSchedule = callback => { const timer = setTimeout(callback, 250); return () => clearTimeout(timer); };
const defaultScheduleDelay: TreeRefreshDelaySchedule = (callback, delayMs) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); };

// A fixed first-change window, not a sliding debounce. Actual unsettled reads retain their slots across reset.
// At most 64 automatic branch reads per configuration/explicit Watch generation; failures require an explicit retry.
// Enforces a per-branch minimum interval (default 5_000ms) after completed automatic refreshes (RX-D1)
// and respects parent-before-child dependencies when `canRun` is provided.
export class TreeRefreshQueue {
  readonly #run: (id: string) => Promise<TreeRefreshResult>;
  readonly #limit: (id: string) => void;
  readonly #schedule: TreeRefreshSchedule;
  readonly #scheduleDelay: TreeRefreshDelaySchedule;
  readonly #now: () => number;
  readonly #minIntervalMs: number;
  readonly #canRun: ((id: string) => boolean) | undefined;
  readonly #pending = new Set<string>();
  readonly #running = new Set<string>();
  readonly #blocked = new Set<string>();
  readonly #trailing = new Set<string>();
  readonly #lastCompletedAt = new Map<string, number>();
  readonly #cooldownTimers = new Map<string, () => void>();
  #cancel: (() => void) | undefined;
  #ready = false;
  #generation = 0;
  #attempts = 0;
  #disposed = false;
  constructor(run: (id: string) => Promise<TreeRefreshResult>, limit: (id: string) => void, scheduling = schedule, options: TreeRefreshQueueOptions = {}) {
    this.#run = run; this.#limit = limit; this.#schedule = scheduling;
    this.#minIntervalMs = options.minIntervalMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    this.#scheduleDelay = options.scheduleDelay ?? defaultScheduleDelay;
    this.#canRun = options.canRun;
  }
  add(ids: readonly string[], options: { readonly automatic?: boolean } = {}): void {
    if (this.#disposed) return;
    const automatic = options.automatic ?? true;
    for (const id of ids) {
      if (!automatic) {
        this.#blocked.delete(id);
        this.#lastCompletedAt.delete(id);
        this.#cooldownTimers.get(id)?.();
        this.#cooldownTimers.delete(id);
      }
      if (this.#blocked.has(id)) continue;
      if (this.#running.has(id)) {
        this.#trailing.add(id);
        continue;
      }
      if (automatic && this.#minIntervalMs > 0) {
        const lastAt = this.#lastCompletedAt.get(id);
        if (lastAt !== undefined) {
          const remaining = lastAt + this.#minIntervalMs - this.#now();
          if (remaining > 0) {
            if (!this.#cooldownTimers.has(id)) {
              const generation = this.#generation;
              const cancelCooldown = this.#scheduleDelay(() => {
                this.#cooldownTimers.delete(id);
                if (this.#disposed || generation !== this.#generation || this.#blocked.has(id)) return;
                this.#pending.add(id);
                this.#ready = true;
                this.#pump();
              }, remaining);
              this.#cooldownTimers.set(id, cancelCooldown);
            }
            continue;
          }
        }
      }
      this.#pending.add(id);
    }
    if (!this.#pending.size || this.#cancel || this.#ready) return;
    let fired = false;
    const cancel = this.#schedule(() => { fired = true; this.#cancel = undefined; this.#ready = true; this.#pump(); });
    if (!fired) this.#cancel = cancel;
  }
  hasActive(id: string): boolean { return this.#pending.has(id) || this.#running.has(id) || this.#cooldownTimers.has(id); }
  #pump(): void {
    if (this.#disposed || !this.#ready) return;
    for (const id of Array.from(this.#pending)) {
      if (this.#running.size >= 2) break;
      if (this.#running.has(id)) continue;
      if (this.#canRun && !this.#canRun(id)) continue;
      this.#pending.delete(id);
      if (this.#attempts >= 64) { this.#blocked.add(id); this.#limit(id); continue; }
      this.#attempts++; this.#running.add(id); const generation = this.#generation;
      void this.#run(id).then(result => {
        if (generation !== this.#generation || this.#disposed) return;
        if (result.phase === 'error') { this.#blocked.add(id); this.#pending.delete(id); this.#trailing.delete(id); }
        else if (result.phase === 'ready') {
          this.#lastCompletedAt.set(id, this.#now());
          this.add(result.children);
        }
      }).catch(() => {
        if (generation === this.#generation && !this.#disposed) { this.#blocked.add(id); this.#pending.delete(id); this.#trailing.delete(id); this.#limit(id); }
      }).finally(() => {
        this.#running.delete(id);
        if (generation === this.#generation && !this.#disposed && this.#trailing.delete(id)) {
          const lastAt = this.#minIntervalMs > 0 ? this.#lastCompletedAt.get(id) : undefined;
          if (lastAt !== undefined && lastAt + this.#minIntervalMs - this.#now() > 0) {
            this.add([id]);
          } else {
            this.#pending.add(id);
            this.#ready = true;
          }
        }
        this.#pump();
      });
    }
    if (!this.#pending.size) this.#ready = false;
  }
  remove(ids: readonly string[]): void {
    for (const id of ids) {
      this.#pending.delete(id);
      this.#trailing.delete(id);
      this.#cooldownTimers.get(id)?.();
      this.#cooldownTimers.delete(id);
    }
  }
  retry(ids: readonly string[]): void {
    for (const id of ids) {
      this.#blocked.delete(id);
      this.#lastCompletedAt.delete(id);
      this.#cooldownTimers.get(id)?.();
      this.#cooldownTimers.delete(id);
    }
  }
  reset(): void {
    ++this.#generation;
    this.#cancel?.(); this.#cancel = undefined;
    for (const cancelCooldown of this.#cooldownTimers.values()) cancelCooldown();
    this.#cooldownTimers.clear();
    this.#ready = false; this.#pending.clear(); this.#blocked.clear(); this.#trailing.clear(); this.#lastCompletedAt.clear(); this.#attempts = 0;
  }
  dispose(): void { this.reset(); this.#disposed = true; }
}
