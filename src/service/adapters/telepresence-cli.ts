// M7 Telepresence CLI adapter: bounded probes and G4-gated traffic operations per the M1
// command-semantics contract (explicit traffic/agent-injection disclosure, real lifecycle,
// never a port-forward substitute). Same audited spawn discipline as the other CLI adapters.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
export type TelepresenceProbe = { readonly code: number; readonly stdout: string } | undefined;
const stdoutBudget = 16_384;
function once(args: readonly string[], path: string, signal: AbortSignal, timeoutMs: number): Promise<TelepresenceProbe> {
  return new Promise(resolve => {
    const child = spawn('telepresence', [...args], { shell: false, detached: true, cwd: '/var/empty', env: { PATH: path, HOME: '/var/empty', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '', failure = false, force: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } }, 500); }, timeoutMs);
    const abort = () => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > stdoutBudget) { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } } });
    child.stdout.on('error', () => { failure = true; });
    child.once('error', error => { if ('code' in error && error.code === 'ENOENT') { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort); resolve(undefined); return; } failure = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort);
      if (failure) { resolve(undefined); return; }
      resolve({ code: code ?? 0, stdout: stdout.slice(0, stdoutBudget) }); });
  });
}
const workload = (value: string) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 253;
export function createTelepresenceCliRunner(path: string) {
  return {
    // Read-only daemon/state probe.
    async status(signal: AbortSignal): Promise<TelepresenceProbe> { return once(['status'], path, signal, 20_000); },
    async version(signal: AbortSignal): Promise<TelepresenceProbe> { return once(['version'], path, signal, 10_000); },
    // The traffic writes (each ONE bounded invocation, G4-gated by the operation layer):
    // connect brings up the daemon; intercept reroutes workload traffic (agent injection
    // disclosure); leave/quit restore. Never force, never a silent retry.
    async connect(signal: AbortSignal): Promise<TelepresenceProbe> { return once(['connect'], path, signal, 120_000); },
    async intercept(target: string, ports: string, signal: AbortSignal): Promise<TelepresenceProbe> {
      if (!workload(target) || !/^\d{1,5}(:\d{1,5})?$/.test(ports)) throw new BoundaryError('INVALID_INPUT');
      return once(['intercept', target, '--port', ports], path, signal, 120_000);
    },
    async leave(target: string, signal: AbortSignal): Promise<TelepresenceProbe> {
      if (!workload(target)) throw new BoundaryError('INVALID_INPUT');
      return once(['leave', target], path, signal, 60_000);
    },
    async quit(signal: AbortSignal): Promise<TelepresenceProbe> { return once(['quit'], path, signal, 60_000); },
  };
}
export type TelepresenceCliRunner = ReturnType<typeof createTelepresenceCliRunner>;
