// WORKSPACE-WRITE chain: `helm package` writes the .tgz archive INTO the user-designated canonical
// workspace destination folder (upstream Save-dialog semantics); any dependency fetch is redirected
// into the plugin-isolated cache with the user's repositories.yaml READ-ONLY. Never invoked by
// automated functional tests. A non-zero exit is a packaging FAILURE with a fixed code; only
// bounded stdout is kept (it carries the saved-to identity) and stderr is never retained. Pure
// projections live in shared/helm-package-protocol.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { packageArguments, workspaceChartDirectory } from '../../shared/helm-package-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmPackageRun = (input: { readonly root: string; readonly path: string; readonly destinationRoot: string; readonly destinationPath: string; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
export function createHelmPackageRunner(path: string, home: string): HelmPackageRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args } = packageArguments(input.root, input.path, input.destinationRoot, input.destinationPath, input.source, home);
    await mkdir(workspaceChartDirectory(input.destinationRoot, input.destinationPath), { recursive: true }); // designated destination only
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = packaging failure (fixed code), never a partial claim.
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('STATE_UNAVAILABLE')); });
    });
  };
}
