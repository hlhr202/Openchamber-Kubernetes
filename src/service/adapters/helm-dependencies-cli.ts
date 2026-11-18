// WRITE-to-plugin-owned-dirs chain: `helm fetch` downloads into the plugin-isolated cache and a
// plugin-owned temp directory UNDER THE SERVICE HOME (never system tmp); `helm dep list` reads the
// archive; the archive and temp directory are removed afterwards exactly as upstream does in its
// finally block. Never invoked by automated functional tests. No workspace write, no user config
// mutation, no install. Pure argument/table projections live in shared/helm-dependencies-protocol.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { helmDependencyFetchArguments, helmDependencyListArguments, pluginTempRoot } from '../../shared/helm-dependencies-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmDependenciesRun = (input: { readonly chart: string; readonly version?: string | undefined; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
function once(args: readonly string[], path: string, signal: AbortSignal, capture: boolean): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
    const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    if (capture && child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
    child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
    child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolve({ code, stdout: stdout.slice(0, budget) }); });
  });
}
export function createHelmDependenciesRunner(path: string, home: string): HelmDependenciesRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const root = pluginTempRoot(home);
    await mkdir(root, { recursive: true }); // plugin-owned temp root only
    const tempDirectory = await mkdtemp(`${root}/vsk-fetchfordeps-`); // upstream prefix
    let chartPath: string | undefined;
    try {
      const fetchArgs = helmDependencyFetchArguments(input.chart, input.version, tempDirectory, input.source, home).args;
      const fetched = await once(fetchArgs, path, signal, false);
      if (fetched.code !== 0) throw new BoundaryError('HELM_INDEX_MISSING'); // stderr never retained
      const entries = await readdir(tempDirectory);
      if (entries.length < 1) throw new BoundaryError('STATE_UNAVAILABLE'); // upstream assumes exactly one archive
      chartPath = `${tempDirectory}/${entries[0]}`;
      const listed = await once(helmDependencyListArguments(chartPath), path, signal, true);
      if (listed.code !== 0) throw new BoundaryError('STATE_UNAVAILABLE');
      return listed.stdout;
    } finally {
      // Upstream finally: unlink the archive, then remove the temp directory.
      if (chartPath) await unlink(chartPath).catch(() => { /* Already gone. */ });
      await rmdir(tempDirectory).catch(() => { /* Best effort, same as upstream removeCallback. */ });
    }
  };
}
