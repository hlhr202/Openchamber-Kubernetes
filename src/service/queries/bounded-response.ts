import { BoundaryError } from '../../shared/errors.ts';
import { requireReadSuccess } from './resource-query.ts';

// An adapter owns precisely this READ's stream/close. This is not a session/operation cleanup hook.
export type ReadResponse = { readonly status: number; readonly retryAfterMs?: number; readonly body: AsyncIterable<Uint8Array>; readonly close: () => Promise<void> };

async function readResponse<T>(response: ReadResponse, signal: AbortSignal, maximumBytes: number, project: (text: string) => T, preserveBOM = false): Promise<T> {
  let failure: BoundaryError | undefined;
  let result: T | undefined;
  try {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8_000_000) throw new BoundaryError('INVALID_INPUT');
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    requireReadSuccess(response.status); // Never iterate/parse a sensitive error body.
    const chunks: Uint8Array[] = [];
    let size = 0, count = 0;
    for await (const chunk of response.body) {
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (!(chunk instanceof Uint8Array)) throw new BoundaryError('RESOURCE_INVALID');
      size += chunk.byteLength;
      if (size > maximumBytes || ++count > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
      chunks.push(Uint8Array.from(chunk)); // A producer may reuse its buffer after yielding.
    }
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBOM }).decode(Buffer.concat(chunks)); }
    catch { throw new BoundaryError('RESOURCE_INVALID'); }
    result = project(text);
  } catch (error) { failure = error instanceof BoundaryError ? error : new BoundaryError('STATE_UNAVAILABLE'); }
  // Await settlement, even when cancelled. A stuck transport must not free the scheduler slot.
  try { await response.close(); }
  catch { failure ??= new BoundaryError('STATE_UNAVAILABLE'); }
  if (failure) throw failure;
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  return result as T;
}
export function readResponseJson(response: ReadResponse, signal: AbortSignal, maximumBytes = 2_000_000): Promise<unknown> {
  return readResponse(response, signal, maximumBytes, text => { try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); } });
}
export function readResponseText(response: ReadResponse, signal: AbortSignal, maximumBytes = 2_000_000): Promise<string> {
  return readResponse(response, signal, maximumBytes, text => text, true);
}
