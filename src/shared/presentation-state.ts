// Plain value comparison only. No JSON serialization, renderer, IO or task control.
// Callers retain immutable snapshots; functions and non-plain objects compare by identity.
export function samePresentation(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth > 64) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => samePresentation(value, b[index], depth + 1));
  if (Array.isArray(b)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(a)) || ![Object.prototype, null].includes(Object.getPrototypeOf(b))) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && samePresentation(left[key], right[key], depth + 1));
}
export function changedPresentationProps<T extends object>(current: T, next: Partial<T>): Partial<T> | undefined {
  const changed: Partial<T> = {}; let count = 0;
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!samePresentation(current[key], next[key])) { changed[key] = next[key]!; count++; }
  }
  return count ? changed : undefined;
}
// Read-task lease renewal is private bookkeeping. Keep source, events, cursors,
// loss, deadlines, phase and errors: identical log lines are still real events.
export function readTaskPresentation<T extends { page?: unknown }>(state: T): unknown {
  const page = state.page;
  if (!page || typeof page !== 'object' || Array.isArray(page)) return state;
  return { ...state, page: { ...page, leaseUntil: 0 } };
}
export function distinctPresentation<T>(show: (state: T) => void, project: (state: T) => unknown = state => state): (state: T) => void {
  let initialized = false, previous: unknown;
  return state => {
    const next = project(state);
    if (initialized && samePresentation(previous, next)) return;
    previous = next; initialized = true; show(state);
  };
}
