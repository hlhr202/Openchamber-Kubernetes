// CLUSTER READ via the Helm CLI: `helm get [all] <release>` against the RESOLVED config selection
// kubeconfig path (pinned via --kubeconfig, never a user-supplied path and never an env var). Never
// invoked by automated functional tests. Only bounded stdout is kept; stderr is never retained. A
// non-zero exit is a fixed failure code (release-not-found and transport errors are not
// distinguished — helm exits 1 for both, disclosed). Pure projections live in shared/helm-get-protocol.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { helmGetArguments } from '../../shared/helm-get-protocol.ts';
import type { HelmSyntax } from '../../shared/helm-version-protocol.ts';
export type HelmGetRun = (input: { readonly syntax: HelmSyntax; readonly release: string; readonly revision?: number | undefined; readonly kubeconfigPath: string }, signal: AbortSignal) => Promise<string>;
const budget = 32_768;
export function createHelmGetRunner(path: string): HelmGetRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const args = helmGetArguments(input.syntax, input.release, input.revision, input.kubeconfigPath);
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = fixed failure (helm gives no exit-code split).
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('STATE_UNAVAILABLE')); });
    });
  };
}
