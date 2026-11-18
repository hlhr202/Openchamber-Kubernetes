// WRITE-to-plugin-isolated-cache chain. The single `helm repo update` writes ONLY into the plugin's
// own cache directory (under the service home); the repository-config flag from shared points helm
// at the user's file READ-ONLY. Never invoked by automated functional tests. No repeat, no rollback,
// no user config mutation, no install. Pure argument/cache projection lives in shared/helm-refresh-protocol.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { helmRefreshArguments } from '../../shared/helm-refresh-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmRefreshRun = (source: HelmRepositorySource, signal: AbortSignal) => Promise<void>;
export function createHelmRepoRefreshRunner(path: string, home: string): HelmRefreshRun {
  return async (source: HelmRepositorySource, signal: AbortSignal): Promise<void> => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args, cache } = helmRefreshArguments(source, home);
    await mkdir(cache, { recursive: true }); // plugin-isolated directory only
    await new Promise<void>((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'ignore', 'ignore'] });
      let failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // A non-zero exit keeps the already-written cache (partial update) without rollback or replay.
        if (failure) reject(failure); else if (code === 0) resolve(); else reject(new BoundaryError('HELM_INDEX_MISSING')); });
    });
  };
}
