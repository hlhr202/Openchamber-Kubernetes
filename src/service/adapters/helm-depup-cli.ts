// WORKSPACE-WRITE chain: `helm dep up` updates Chart.lock and the vendored charts/ subtree INSIDE
// the canonical workspace chart directory; dependency downloads are redirected into the
// plugin-isolated cache with the user's repositories.yaml READ-ONLY. Never invoked by automated
// functional tests. A non-zero exit is an update failure (fixed code); only bounded stdout is kept
// and stderr is never retained. Pure projections live in shared/helm-depup-protocol.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { depUpArguments } from '../../shared/helm-depup-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmDepUpRun = (input: { readonly root: string; readonly path: string; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
export function createHelmDepUpRunner(path: string, home: string): HelmDepUpRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args } = depUpArguments(input.root, input.path, input.source, home);
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = update failure (fixed code), never a partial claim.
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('STATE_UNAVAILABLE')); });
    });
  };
}
