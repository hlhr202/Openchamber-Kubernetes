// Runtime-only external authentication, invoked on demand for an actual cluster transport.
// No requests on construction/import; never imported or invoked by functional tests.
import { execFile } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import { execCredentialSchema, execCredentialExpiryMs, execCredentialCacheLimits, execCredentialRequestDocument } from '../../shared/exec-credential-protocol.ts';
import type { ExecPluginSpec } from '../../shared/exec-credential-protocol.ts';

export async function executeCredentialPlugin(spec: ExecPluginSpec, signal: AbortSignal,
  environment: Readonly<Record<string, string>>, cluster?: Readonly<Record<string, unknown>>) {
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  if (spec.interactiveMode === 'Always') throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  // Only an allowlisted runtime environment, never the service's complete environment.
  const env: Record<string, string> = { ...environment };
  for (const entry of spec.env ?? []) env[entry.name] = entry.value;
  // The selected source and exec info cannot be redirected by a stale inherited value.
  env.KUBECONFIG = environment.KUBECONFIG ?? '';
  env.KUBERNETES_EXEC_INFO = execCredentialRequestDocument(spec.apiVersion, spec.provideClusterInfo ? cluster : undefined);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(spec.command, [...(spec.args ?? [])], {
      timeout: execCredentialCacheLimits.runTimeoutMs, maxBuffer: execCredentialCacheLimits.stdoutMaxBytes,
      env, shell: false, windowsHide: true, killSignal: 'SIGKILL',
    }, (error, output) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new BoundaryError('QUERY_CANCELLED'));
      else if (error) reject(new BoundaryError('code' in error && error.code === 'ENOENT' ? 'AUTH_PLUGIN_NOT_FOUND' : error.killed ? 'QUERY_TIMEOUT' : 'AUTHENTICATION_UNAVAILABLE'));
      else resolve(output);
    });
    const abort = () => child.kill('SIGKILL');
    child.stdin?.end();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new BoundaryError('AUTHENTICATION_UNAVAILABLE'); }
  const result = execCredentialSchema.safeParse(value);
  if (!result.success || result.data.apiVersion !== spec.apiVersion) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  const now = Date.now(), expiry = execCredentialExpiryMs(result.data.status, now);
  if (result.data.status.expirationTimestamp && (expiry === undefined || expiry <= now)) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  return { status: result.data.status, expiresAt: expiry ?? now + execCredentialCacheLimits.maxLifetimeMs };
}
