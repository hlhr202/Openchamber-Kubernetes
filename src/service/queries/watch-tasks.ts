import { watchSourceSchema, watchEventSchema, watchPageSchema } from '../../shared/watch-protocol.ts';
import type { WatchSource, WatchEvent } from '../../shared/watch-protocol.ts';
import { createReadTasks } from './read-tasks.ts';
import type { createReadTaskBudget } from './read-tasks.ts';
export function createWatchTasks(options: { generation: string; run: (source: WatchSource, signal: AbortSignal, emit: (event: Omit<WatchEvent, 'sequence'>) => void) => Promise<void>; clock?: () => number; budget?: ReturnType<typeof createReadTaskBudget> }) {
  return createReadTasks({ ...options, kind: 'resource-watch', sourceSchema: watchSourceSchema, eventSchema: watchEventSchema, pageSchema: watchPageSchema });
}
