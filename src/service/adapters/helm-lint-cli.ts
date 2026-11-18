// Bounded lint read over a canonical workspace chart directory. `helm lint` writes at most to the
// repository cache when dependencies are missing, so the run points helm at the user's
// repositories.yaml READ-ONLY and redirects any download into the plugin-isolated cache. Never
// invoked by automated functional tests. A non-zero exit is a lint-FINDINGS result, not a tool
// failure; only bounded stdout is kept and stderr is never retained. Pure projections live in
// shared/helm-lint-protocol.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { helmLintArguments } from '../../shared/helm-lint-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmLintRun = (input: { readonly root: string; readonly path: string; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<{ failed: boolean; stdout: string }>;
const budget = 16_384;
export function createHelmLintRunner(path: string, home: string): HelmLintRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args } = helmLintArguments(input.root, input.path, input.source, home);
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = findings result (failed: true), not rejection.
        if (failure) reject(failure); else resolve({ failed: code !== 0, stdout: stdout.slice(0, budget) }); });
    });
  };
}
