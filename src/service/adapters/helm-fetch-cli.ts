// WORKSPACE-WRITE chain: `helm fetch --untar` downloads the chart into the plugin-isolated cache
// (user's repositories.yaml READ-ONLY) and untars the chart tree INTO the designated canonical
// workspace destination. Never invoked by automated functional tests. A non-zero exit is a fetch
// failure with a fixed code; only bounded stdout is kept and stderr is never retained. Pure
// projections live in shared/helm-fetch-protocol.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { fetchArguments, workspaceChartDirectory } from '../../shared/helm-fetch-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmFetchRun = (input: { readonly chart: string; readonly version?: string | undefined; readonly root: string; readonly path: string; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
export function createHelmFetchRunner(path: string, home: string): HelmFetchRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args } = fetchArguments(input.chart, input.version, input.root, input.path, input.source, home);
    await mkdir(workspaceChartDirectory(input.root, input.path), { recursive: true }); // designated destination only
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = fetch failure (fixed code), never a partial claim.
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('HELM_INDEX_MISSING')); });
    });
  };
}
