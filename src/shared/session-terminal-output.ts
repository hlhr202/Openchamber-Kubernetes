// Pure bounded terminal transcript values; no renderer, session, input or IO.
import { z } from 'zod';
const point = z.object({ x: z.number().int().min(0).max(120), y: z.number().int().min(0).max(168) }).strict();
export const terminalScreenSchema = z.object({
  id: z.string().uuid(), end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), vt: z.string().max(1_048_576),
  columns: z.number().int().min(20).max(120), rows: z.number().int().min(10).max(40),
  viewport: z.number().int().min(0).max(128), focused: z.boolean(),
  selection: z.object({ start: point, end: point }).strict().optional(),
}).strict();
export function appendSessionOutput(output: string, start: number, addition: string) {
  const combined = output + addition;
  let remove = Math.max(0, combined.length - 131_072);
  // Never start a retained UTF-16 window halfway through a surrogate pair.
  if (remove && combined.charCodeAt(remove) >= 0xdc00 && combined.charCodeAt(remove) <= 0xdfff) remove++;
  return { output: combined.slice(remove), start: start + remove, dropped: remove > 0 };
}
export type TerminalOutputCursor = { id: string; end: number };
export function terminalOutputDelta(cursor: TerminalOutputCursor | undefined, next: { id: string; outputStart: number; output: string }) {
  const end = next.outputStart + next.output.length;
  if (cursor?.id === next.id && end < cursor.end) return { reset: false, text: '', cursor };
  const reset = cursor?.id !== next.id || cursor.end < next.outputStart;
  return { reset, text: reset ? next.output : next.output.slice(cursor.end - next.outputStart), cursor: { id: next.id, end } };
}
