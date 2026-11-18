// Bounded template render over a canonical workspace chart directory. `helm template` writes at
// most to the repository cache when dependencies are missing, so the run points helm at the user's
// repositories.yaml READ-ONLY and redirects any download into the plugin-isolated cache. Never
// invoked by automated functional tests. A non-zero exit is a render FAILURE (upstream shows an
// error); only bounded stdout is kept and stderr is never retained. Pure projections live in
// shared/helm-template-protocol.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { helmTemplateArguments } from '../../shared/helm-template-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmTemplateRun = (input: { readonly root: string; readonly path: string; readonly source: HelmRepositorySource }, signal: AbortSignal) => Promise<string>;
const budget = 16_384;
export function createHelmTemplateRunner(path: string, home: string): HelmTemplateRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const { args } = helmTemplateArguments(input.root, input.path, input.source, home);
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        // stderr is never retained; non-zero exit = render failure (fixed code), never a partial claim.
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, budget)); else reject(new BoundaryError('STATE_UNAVAILABLE')); });
    });
  };
}
// Single-template preview render (--show-only on v3/v4, --execute on v2 — upstream verbatim).
// Same isolation and failure contract as the full render; the preview budget is 256KiB.
export type HelmTemplatePreviewRun = (input: { readonly root: string; readonly chartPath: string; readonly relativeTemplate: string; readonly version: 2 | 3 | 4 }, signal: AbortSignal) => Promise<string>;
const previewBudget = 262_144;
export function createHelmTemplatePreviewRunner(path: string, home: string): HelmTemplatePreviewRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const cache = `${home}/.openchamber-kubernetes/helm-cache`;
    const args = [`--repository-config=${cache}/repositories.yaml`, `--repository-cache=${cache}/helm-index`, ...(input.version === 3 || input.version === 4 ? ['template', input.chartPath, '--show-only', input.relativeTemplate] : ['template', input.chartPath, '--execute', input.relativeTemplate])];
    return new Promise((resolve, reject) => {
      const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } }, 500); };
      const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      if (child.stdout) { child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > previewBudget) stop('BUDGET_EXCEEDED'); }); child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); }
      child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
      child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } clearTimeout(force); } signal.removeEventListener('abort', abort);
        if (failure) reject(failure); else if (code === 0) resolve(stdout.slice(0, previewBudget)); else reject(new BoundaryError('STATE_UNAVAILABLE')); });
    });
  };
}
