// Dedicated WRITE adapter; never imported/constructed/called by automatic functional tests.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundaryError } from '../../shared/errors.ts';
import { isolatedKubectlEnvironment } from '../queries/kubectl-plan.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { createWorkerReadySchema, createWorkerResultSchema, manifestCreateWorkerDeadlineMs, manifestCreateWorkerFlag, parseCreateWorkerStart } from '../operations/manifest-create-worker-protocol.ts';
import type { CreateWorkerResult } from '../operations/manifest-create-worker-protocol.ts';
import type { ManifestCreateDispatch, ManifestCreateResult } from '../operations/manifest-create.ts';
export function createKubectlManifestCreateAdapter(config: ReturnType<typeof createConfigReader>, path: string, entry: URL) {
  return async (request: ManifestCreateDispatch, beforeDispatch: (workerLive: () => boolean) => Promise<void>, signal: AbortSignal): Promise<ManifestCreateResult> => {
    if (!path || !((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const configuration = await config.transportRead(request.selection, request.target.configIdentity, signal, request.target), snapshot = privateKubectlConfiguration(configuration.merged, request.target), body = Buffer.from(request.text);
    try {
      const start = parseCreateWorkerStart({ protocol: 1, kind: 'manifest-create', target: request.target, reference: request.reference, ...(request.generated !== undefined ? { generated: request.generated } : {}), snapshot, body,
        digest: createHash('sha256').update(body).digest('hex'), path, notAfter: request.notAfter });
      return await new Promise<ManifestCreateResult>(resolve => {
        const filename = fileURLToPath(entry), worker = fork(filename, [manifestCreateWorkerFlag], { execPath: process.execPath, execArgv: [], detached: true,
          cwd: dirname(filename), serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...isolatedKubectlEnvironment('/var/empty', path), TMPDIR: tmpdir(), ELECTRON_RUN_AS_NODE: '1' } });
        let result: CreateWorkerResult | undefined, invalid = false, ready = false, closed = false, dispatched = false, approval: Promise<void> | undefined;
        const stop = () => { invalid = true; if (worker.connected) { try { worker.disconnect(); } catch { /* Already gone. */ } } worker.kill('SIGTERM'); };
        const deadline = setTimeout(stop, manifestCreateWorkerDeadlineMs + 1000), abort = () => { if (!dispatched) stop(); }; signal.addEventListener('abort', abort, { once: true });
        worker.on('error', stop);
        worker.on('message', (input: unknown) => {
          if (!ready && createWorkerReadySchema.safeParse(input).success) {
            ready = true;
            approval = (async () => {
              try { await beforeDispatch(() => !closed && !invalid && !signal.aborted && Date.now() < request.notAfter); if (closed || invalid || signal.aborted || Date.now() >= request.notAfter) { stop(); return; }
                dispatched = true; worker.send({ protocol: 1, kind: 'create-go' }, error => { if (error) stop(); });
              } catch { stop(); }
            })(); return;
          }
          const parsed = createWorkerResultSchema.safeParse(input); if (result || !parsed.success || parsed.data.phase === 'succeeded' && !dispatched) stop(); else result = parsed.data;
        });
        worker.once('close', code => {
          closed = true; clearTimeout(deadline); signal.removeEventListener('abort', abort);
          void Promise.resolve(approval).then(() => {
            if (!invalid && code === 0 && result) resolve(result);
            else resolve({ phase: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : 'STATE_UNAVAILABLE', cleanup: 'manual-check' });
          }); // Keep the actual slot until both worker close and its pending final proof settle; no late ledger resurrection.
        });
        if (signal.aborted) stop(); else { try { worker.send(start, error => { if (error) stop(); }); } catch { stop(); } }
      });
    } finally { snapshot.fill(0); body.fill(0); }
  };
}
