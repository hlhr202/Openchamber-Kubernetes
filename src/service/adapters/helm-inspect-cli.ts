// WRITE-to-plugin-isolated-cache chain shaped as a bounded preview read: `helm inspect [all]`
// downloads the chart into the repository cache, so the run points helm at the user's
// repositories.yaml READ-ONLY and redirects every download into the plugin-isolated cache under the
// service home. Never invoked by automated functional tests. No retry, no user config mutation, no
// install. Pure argument/scope projection lives in shared/helm-inspect-protocol.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { helmInspectArguments } from '../../shared/helm-inspect-protocol.ts';
import type { HelmSyntax } from '../../shared/helm-version-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmInspectRun = (input: { readonly syntax: HelmSyntax; readonly chart: string; readonly version?: string | undefined; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
export function createHelmInspectRunner(path: string, home: string): HelmInspectRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args, cache } = helmInspectArguments(input.syntax, input.chart, input.version, input.source, home);
    await mkdir(cache, { recursive: true }); // plugin-isolated directory only
    return new Promise<string>((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); });
      child.stdout.on('error', () => stop('STATE_UNAVAILABLE'));
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; a non-zero exit leaves the isolated cache as-is, no rollback.
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('HELM_INDEX_MISSING')); });
    });
  };
}
