import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundaryError } from '../../shared/errors.ts';
import { isolatedKubectlEnvironment } from '../queries/kubectl-plan.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { deleteWorkerDeadlineMs, deleteWorkerFlag, deleteWorkerResultSchema, parseDeleteWorkerStart } from '../operations/delete-worker-protocol.ts';
import type { DeleteWorkerResult } from '../operations/delete-worker-protocol.ts';
import type { DeleteDispatch, DeleteResult } from '../operations/delete.ts';

// Dedicated WRITE adapter. Never called from tests, health, reads, bootstrap or disposal.
export function createKubectlDeleteAdapter(config: ReturnType<typeof createConfigReader>, path: string, entry: URL) {
  return async (request: DeleteDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<DeleteResult> => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const configuration = await config.transportRead(request.selection, request.target.configIdentity, signal, request.target);
    const snapshot = privateKubectlConfiguration(configuration.merged, request.target);
    try {
      if (!path) throw new BoundaryError('CLI_NOT_FOUND');
      const start = parseDeleteWorkerStart({ protocol: 1, kind: 'delete', target: request.target, parameters: request.parameters, notAfter: request.notAfter, snapshot, path });
      beforeDispatch();
      const result = await new Promise<DeleteWorkerResult>(resolve => {
        const filename = fileURLToPath(entry), worker = fork(filename, [deleteWorkerFlag], { execPath: process.execPath, execArgv: [], detached: true,
          cwd: dirname(filename), serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...isolatedKubectlEnvironment('/var/empty', path), TMPDIR: tmpdir(), ELECTRON_RUN_AS_NODE: '1' } });
        let result: DeleteWorkerResult | undefined, invalid = false;
        const stop = () => { invalid = true; if (worker.connected) { try { worker.disconnect(); } catch { /* Already gone. */ } } worker.kill('SIGTERM'); };
        const deadline = setTimeout(stop, deleteWorkerDeadlineMs + 1000);
        worker.on('error', stop);
        worker.on('message', (input: unknown) => { const parsed = deleteWorkerResultSchema.safeParse(input); if (result || !parsed.success) stop(); else result = parsed.data; });
        worker.once('close', code => { clearTimeout(deadline); resolve(!invalid && code === 0 && result ? result : { protocol: 1, kind: 'delete-result', outcome: 'unknown', code: 'OPERATION_UNKNOWN' }); });
        try { worker.send(start, error => { if (error) stop(); }); } catch { stop(); }
      });
      return { outcome: result.outcome, ...(result.code ? { code: result.code } : {}) };
    } finally { snapshot.fill(0); }
  };
}
