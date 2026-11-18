import { BoundaryError } from '../../shared/errors.ts';

// WRITE coordination only. No I/O on construction; never exercised by functional tests.
// One conservative service-wide lock covers aliases, overlapping selections and old config versions.
export class ConfigurationWriteLock {
  #active = false;
  readonly #queue: { start: () => void; cancel: () => void }[] = [];
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new BoundaryError('QUERY_CANCELLED'));
    if (this.#queue.length >= 16) return Promise.reject(new BoundaryError('QUERY_LIMIT'));
    return new Promise<T>((resolve, reject) => {
      const item = { start: () => {
        signal.removeEventListener('abort', item.cancel);
        if (signal.aborted) { reject(new BoundaryError('QUERY_CANCELLED')); this.#next(); return; }
        this.#active = true;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => { this.#active = false; this.#next(); });
      }, cancel: () => { const index = this.#queue.indexOf(item); if (index >= 0) { this.#queue.splice(index, 1); reject(new BoundaryError('QUERY_CANCELLED')); } } };
      if (this.#active) { this.#queue.push(item); signal.addEventListener('abort', item.cancel, { once: true }); if (signal.aborted) item.cancel(); }
      else item.start();
    });
  }
  #next() { this.#queue.shift()?.start(); }
}
