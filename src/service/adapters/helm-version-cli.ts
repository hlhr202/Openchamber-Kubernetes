// READ-ONLY one-shot Helm CLI version probe. Never invoked by automated functional tests.
// No kubeconfig, no cluster, no plugin/config load: isolated PATH-only environment, fixed errors,
// no stderr retention, no global syntax cache (each read re-probes), no install or env mutation.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { classifyHelmSyntax, helmVersionArguments, projectHelmVersion } from '../../shared/helm-version-protocol.ts';
import type { HelmSyntax, HelmVersionProbe } from '../../shared/helm-version-protocol.ts';
export type { HelmVersionProbe };
const budget = 16_384;
function once(executable: string, args: readonly string[], path: string, signal: AbortSignal): Promise<HelmVersionProbe | undefined> {
  return new Promise(resolve => {
    const child = spawn(executable, [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
    const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > budget) stop('BUDGET_EXCEEDED'); });
    child.stdout.on('error', () => stop('STATE_UNAVAILABLE'));
    child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
    child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); }
      signal.removeEventListener('abort', abort);
      if (failure) { if (failure.code === 'CLI_NOT_FOUND') { resolve(undefined); return; } resolve(undefined); return; }
      resolve({ code: code ?? 0, stdout: stdout.slice(0, budget) }); });
  });
}
// The spawn side is the only effect; classification/projection live in the shared pure protocol.
export function createHelmVersionCliRunner(path: string) {
  return async (signal: AbortSignal): Promise<{ syntax: HelmSyntax; output: string }> => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    const probeV2 = await once('helm', ['version', '--short', '-c'], path, signal);
    const probeModern = await once('helm', ['version', '--short'], path, signal);
    const syntax = classifyHelmSyntax(probeV2, probeModern);
    const display = await once('helm', helmVersionArguments(syntax), path, signal);
    return projectHelmVersion(probeV2, probeModern, display); // CLI_NOT_FOUND surfaces as CLI_INCOMPATIBLE probes → unknown
  };
}
