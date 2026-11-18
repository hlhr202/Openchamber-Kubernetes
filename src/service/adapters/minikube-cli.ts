// M7 minikube CLI adapter: bounded status probe + G4-gated start/stop. Mirrors the audited
// git/helm CLI discipline: spawn without shell, isolated PATH-only env, bounded stdout (never
// stderr), abort kills the owned process group, no retries, no auto-install.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
export type MinikubeProbe = { readonly code: number; readonly stdout: string } | undefined;
function once(args: readonly string[], path: string, signal: AbortSignal, timeoutMs: number): Promise<MinikubeProbe> {
  return new Promise(resolve => {
    const child = spawn('minikube', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '', failure = false, force: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } }, 500); }, timeoutMs);
    const abort = () => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 16_384) { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } } });
    child.stdout.on('error', () => { failure = true; });
    child.once('error', error => { if ('code' in error && error.code === 'ENOENT') { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort); resolve(undefined); return; } failure = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort);
      if (failure) { resolve(undefined); return; }
      resolve({ code: code ?? 0, stdout: stdout.slice(0, 16_384) }); });
  });
}
export function createMinikubeCliRunner(path: string) {
  return {
    // Read-only probes, upstream verbatim argument shapes.
    async status(signal: AbortSignal): Promise<MinikubeProbe> { return once(['status', '--output=json'], path, signal, 20_000); },
    async profileList(signal: AbortSignal): Promise<MinikubeProbe> { return once(['profile', 'list', '--output=json'], path, signal, 20_000); },
    // The two writes: ONE bounded invocation each, G4-gated by the operation layer.
    async start(driver: string, signal: AbortSignal): Promise<MinikubeProbe> {
      if (!/^[a-z0-9-]{1,32}$/.test(driver)) throw new BoundaryError('INVALID_INPUT');
      return once(['start', `--driver=${driver}`], path, signal, 600_000);
    },
    async stop(signal: AbortSignal): Promise<MinikubeProbe> { return once(['stop'], path, signal, 120_000); },
    // Upstream minikube configure leg (read-only): `minikube kubectl -- config view` bounded.
    async kubectlConfigView(signal: AbortSignal): Promise<MinikubeProbe> { return once(['kubectl', '--', 'config', 'view'], path, signal, 30_000); },
  };
}
export type MinikubeCliRunner = ReturnType<typeof createMinikubeCliRunner>;
export function minikubeUnavailable(): BoundaryError { return new BoundaryError('CLI_NOT_FOUND'); }
