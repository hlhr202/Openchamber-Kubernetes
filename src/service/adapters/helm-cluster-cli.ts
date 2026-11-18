// Approved D-01 helm cluster WRITE transport: helm CLI with ZERO kubeconfig materialisation.
// Never imported, constructed or invoked by automatic functional tests. The connection comes
// from the shared direct snapshot: --kube-apiserver as argv (non-secret), the bearer token ONLY
// via the in-memory HELM_KUBETOKEN environment variable (never argv, never a file), and an
// optional PUBLIC CA written 0600 inside a 0700 temp dir passed as --kube-ca-file and destroyed
// (overwrite + unlink) in a finally block. One helm invocation per dispatch; no retries.
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { HelmWriteParameters } from '../../shared/helm-release-protocol.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { directConnection } from './manifest-apply-https.ts';

export type HelmClusterDispatch = { readonly target: TargetIdentity; readonly selection: ConfigSelection; readonly namespace: string; readonly parameters: HelmWriteParameters; readonly notAfter: number };
export type HelmClusterResult = { readonly outcome: 'accepted' | 'failed' | 'unknown'; readonly code?: ErrorCode; readonly stdoutTail?: string };
// Upstream-verbatim helm argv per action (helm 3): install NAME CHART [--version] [-f values],
// rollback NAME REVISION, uninstall NAME. The kube-apiserver/namespace join as CLI flags.
export function helmClusterArguments(action: HelmWriteParameters, server: string, caFile: string | undefined): readonly string[] {
  // Deliberately NO --kubeconfig and NO --kube-context (the D-01 zero-materialisation rules).
  const base = ['--kube-apiserver', server, '--namespace', action.namespace, ...(caFile ? ['--kube-ca-file', caFile] : [])];
  if (action.action === 'install') return [...base, 'install', action.release, action.chart, ...(action.chartVersion ? ['--version', action.chartVersion] : []), ...(action.values ? ['-f', '-'] : [])];
  if (action.action === 'rollback') return [...base, 'rollback', action.release, String(action.revision)];
  return [...base, 'uninstall', action.release];
}
export function createHelmClusterCliRunner(path: string, config: ReturnType<typeof createConfigReader>) {
  return async (input: HelmClusterDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<HelmClusterResult> => {
    if (!path) throw new BoundaryError('CLI_NOT_FOUND');
    const transport = await directConnection(config, input, signal);
    let directory: string | undefined, caFile: string | undefined;
    let dispatched = false;
    try {
      if (transport.ca) {
        directory = await mkdtemp(join(tmpdir(), 'oc-k8s-helm-'));
        await chmod(directory, 0o700);
        caFile = join(directory, 'ca.pem');
        const file = await open(caFile, 'w', 0o600);
        await file.writeFile(transport.ca); await file.close();
      }
      const args = helmClusterArguments(input.parameters, transport.server.toString(), caFile);
      if (signal.aborted || Date.now() >= input.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      beforeDispatch();
      dispatched = true;
      return await new Promise<HelmClusterResult>(resolve => {
        const child = spawn('helm', [...args], { shell: false, detached: true, cwd: '/var/empty',
          env: { PATH: path, HOME: '/var/empty', HELM_KUBETOKEN: transport.token, LANG: 'C', LC_ALL: 'C' },
          stdio: [input.parameters.action === 'install' && 'values' in input.parameters && input.parameters.values ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = 0, failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
        const stop = (code: 'QUERY_CANCELLED' | 'QUERY_TIMEOUT' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } }, 500); };
        const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop('QUERY_TIMEOUT'), 60_000);
        if (child.stdin && input.parameters.action === 'install' && 'values' in input.parameters && input.parameters.values) { child.stdin.end(input.parameters.values); } else if (child.stdin) child.stdin.end();
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 65_536) stop('BUDGET_EXCEEDED'); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65_536) stop('BUDGET_EXCEEDED'); }); // never retained or reflected
        child.stdout?.on('error', () => stop('STATE_UNAVAILABLE')); child.stderr?.on('error', () => stop('STATE_UNAVAILABLE'));
        child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
        child.once('close', code => {
          clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort);
          if (failure) { resolve({ outcome: dispatched ? 'unknown' : 'failed', code: failure.code, ...(stdout ? { stdoutTail: stdout.slice(-2_048) } : {}) }); return; }
          resolve(code === 0 ? { outcome: 'accepted', ...(stdout ? { stdoutTail: stdout.slice(-2_048) } : {}) }
            : { outcome: 'failed', code: code === 1 ? 'STATE_UNAVAILABLE' : 'STATE_UNAVAILABLE', ...(stdout ? { stdoutTail: stdout.slice(-2_048) } : {}) });
        });
      });
    } catch (error) {
      return { outcome: dispatched ? 'unknown' : 'failed', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally {
      // Public CA destruction: overwrite then unlink; the directory goes too. Nothing persists.
      if (caFile) { try { const file = await open(caFile, 'r+'); const size = (await file.stat()).size; await file.write(Buffer.alloc(Number(size) || 1, 0)); await file.close(); await unlink(caFile); } catch { /* best effort */ } }
      if (directory) { try { await rm(directory, { recursive: true, force: true }); } catch { /* best effort */ } }
      transport.ca?.fill(0);
    }
  };
}
export const helmTokenEnvironmentKey = 'HELM_KUBETOKEN';
