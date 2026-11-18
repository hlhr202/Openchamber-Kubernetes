// Bounded git CLI adapter for the approved batch-2 Sync chain. Never invoked by automated
// functional tests. Read-only creation-time probe + ONE confirmed checkout; no destructive git
// verbs anywhere,
// no shell, no retained stderr, no user/system git config reads, abort kills the owned process
// group only. A commitId can never become an option: leading '-' is rejected at the protocol.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
export type GitCliProbe = { readonly code: number; readonly stdout: string } | undefined;
function once(root: string, args: readonly string[], path: string, signal: AbortSignal, stdoutBudget: number): Promise<GitCliProbe> {
  return new Promise(resolve => {
    const child = spawn('git', [...args], { shell: false, detached: true, cwd: root,
      env: { PATH: path, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned new process group only. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } }, 500); };
    const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > stdoutBudget) stop('BUDGET_EXCEEDED'); });
    child.stdout.on('error', () => stop('STATE_UNAVAILABLE'));
    child.stderr.on('data', (chunk: Buffer) => { if (chunk.length > 65_536) stop('BUDGET_EXCEEDED'); }); // Never retain or reflect git stderr.
    child.stderr.on('error', () => stop('STATE_UNAVAILABLE'));
    child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
    child.once('close', code => { if (force) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } } clearTimeout(force); }
      signal.removeEventListener('abort', abort);
      if (failure && failure.code === 'CLI_NOT_FOUND') { resolve(undefined); return; }
      if (failure) { resolve(undefined); return; }
      resolve({ code: code ?? 0, stdout: stdout.slice(0, stdoutBudget) }); });
  });
}
// Read-only creation-time probe, upstream verbatim: git log --pretty=%ar -n 1 <id>.
export function createGitCliRunner(path: string) {
  return {
    async whenCreated(root: string, commitId: string, signal: AbortSignal): Promise<string | null> {
      if (commitId.startsWith('-')) throw new BoundaryError('INVALID_INPUT');
      const probe = await once(root, ['log', '--pretty=%ar', '-n', '1', commitId], path, signal, 256);
      if (probe === undefined) throw new BoundaryError('CLI_NOT_FOUND');
      if (probe.code !== 0) return null; // unknown commit: upstream still offers the name/ID lookup
      const trimmed = probe.stdout.trim();
      return trimmed.length ? trimmed : null;
    },
    // The ONE confirmed checkout; a non-zero exit is a fixed failure, never a destructive verb.
    async checkout(root: string, commitId: string, signal: AbortSignal): Promise<void> {
      if (commitId.startsWith('-')) throw new BoundaryError('INVALID_INPUT');
      const probe = await once(root, ['checkout', commitId], path, signal, 1024);
      if (probe === undefined) throw new BoundaryError('CLI_NOT_FOUND');
      if (probe.code !== 0) throw new BoundaryError('STATE_UNAVAILABLE');
    },
  };
}
