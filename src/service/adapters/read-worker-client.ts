import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundaryError } from '../../shared/errors.ts';
import { isolatedKubectlEnvironment } from '../queries/kubectl-plan.ts';
import { parseReadWorkerResult, parseReadWorkerStart, readWorkerDeadlineMs, readWorkerFlag } from '../queries/read-worker-protocol.ts';
import type { ReadWorkerResult } from '../queries/read-worker-protocol.ts';
import { watchChunkSchema, logFollowWorkerDeadlineMs } from '../queries/read-worker-protocol.ts';

// No process on import/construction. The entry is supplied only by runtime/main, never JSON.
export async function readThroughWorker(entry: URL, input: unknown, signal: AbortSignal, onChunk?: (bytes: Uint8Array) => Promise<void>) {
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  const start = parseReadWorkerStart(input);
  if ((start.request.purpose === 'resource-watch' || start.request.purpose === 'custom-resource-watch' || start.request.purpose === 'pod-log-follow' || start.request.purpose === 'namespace-event-watch' || start.request.purpose === 'job-pod-watch') !== !!onChunk) throw new BoundaryError('INVALID_INPUT');
  const filename = fileURLToPath(entry);
  return new Promise<Extract<ReadWorkerResult, { ok: true }>>((resolve, reject) => {
    const worker = fork(filename, [readWorkerFlag], { execPath: process.execPath, execArgv: [], detached: true,
      cwd: dirname(filename), serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...isolatedKubectlEnvironment('/var/empty', start.path), TMPDIR: tmpdir(), ELECTRON_RUN_AS_NODE: '1' } });
    let result: ReadWorkerResult | undefined, failure: BoundaryError | undefined;
    let receiving = false, sequence = 0, bytes = 0;
    const stop = (error: BoundaryError) => {
      if (failure) return;
      failure = error;
      if (worker.connected) { try { worker.disconnect(); } catch { /* IPC already gone. */ } }
      worker.kill('SIGTERM'); // Never SIGKILL the supervisor out from under its owned CLI cleanup.
    };
    const abort = () => stop(new BoundaryError('QUERY_CANCELLED'));
    const deadline = setTimeout(() => stop(new BoundaryError('QUERY_TIMEOUT')), (start.request.purpose === 'pod-log-follow' ? logFollowWorkerDeadlineMs : readWorkerDeadlineMs) + 1000);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('error', () => stop(new BoundaryError('STATE_UNAVAILABLE')));
    worker.on('message', (message: unknown) => {
      const chunk = watchChunkSchema.safeParse(message);
      if (chunk.success) {
        if (!onChunk || receiving || result || failure || chunk.data.sequence !== ++sequence || (bytes += chunk.data.body.byteLength) > 2_000_000) { stop(new BoundaryError('STATE_UNAVAILABLE')); return; }
        receiving = true;
        void onChunk(chunk.data.body).then(() => {
          receiving = false; if (failure || !worker.connected) return;
          try { worker.send({ protocol: 1, kind: 'watch-ack', sequence }, error => { if (error) stop(new BoundaryError('STATE_UNAVAILABLE')); }); } catch { stop(new BoundaryError('STATE_UNAVAILABLE')); }
        }, error => { receiving = false; stop(error instanceof BoundaryError ? error : new BoundaryError('STATE_UNAVAILABLE')); }); return;
      }
      if (receiving) { stop(new BoundaryError('STATE_UNAVAILABLE')); return; }
      if (result) { stop(new BoundaryError('STATE_UNAVAILABLE')); return; }
      try { result = parseReadWorkerResult(message, start.request.maximumBytes); if (onChunk && result.ok && result.body.byteLength) stop(new BoundaryError('STATE_UNAVAILABLE')); }
      catch { stop(new BoundaryError('STATE_UNAVAILABLE')); }
    });
    worker.once('close', code => {
      clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new BoundaryError('STATE_UNAVAILABLE'));
      else if (!result.ok) reject(new BoundaryError(result.code));
      else resolve(result);
    });
    if (signal.aborted) abort();
    else { try { worker.send(start, error => { if (error) stop(new BoundaryError('STATE_UNAVAILABLE')); }); } catch { stop(new BoundaryError('STATE_UNAVAILABLE')); } }
  });
}
