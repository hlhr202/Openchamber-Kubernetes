// Actual WRITE transport for the approved batch-2 ImageRun chain. Never imported, constructed or
// invoked by automatic functional tests. One sequential dispatch: build (docker, fall back to
// buildah) -> push -> ONE direct POST of the kubectl-run-shaped Pod via https-once. The first
// failure stops the chain; a dispatched-but-unfinished step is only reported, never retried.
import { spawn } from 'node:child_process';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { targetSchema } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { documentProperty, documentString, parseDocumentJson } from '../../shared/document-json.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';

export type ImageRunDispatch = { readonly target: TargetIdentity; readonly selection: ConfigSelection; readonly root: string; readonly contextPath: string;
  readonly image: string; readonly name: string; readonly version: string; readonly notAfter: number };
export type ImageRunResult = { readonly outcome: 'accepted' | 'failed' | 'unknown'; readonly code?: ErrorCode;
  readonly built?: boolean; readonly pushed?: boolean; readonly podUid?: string; readonly podResourceVersion?: string };
function runCli(executable: string, args: readonly string[], cwd: string, path: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number | undefined; found: boolean }> {
  return new Promise(resolve => {
    const child = spawn(executable, [...args], { shell: false, detached: true, cwd, env: { PATH: path, HOME: cwd, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'ignore'] });
    let failure = false, force: ReturnType<typeof setTimeout> | undefined, found = true;
    const timer = setTimeout(() => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Gone. */ } } }, 500); }, timeoutMs);
    const abort = () => { failure = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned group. */ } } };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => { if ('code' in error && error.code === 'ENOENT') found = false; failure = true; });
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', abort); resolve({ code: failure ? undefined : code ?? 0, found }); });
  });
}
export function createImageRunAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (input: ImageRunDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ImageRunResult> => {
    targetSchema.parse(input.target);
    if (input.image.includes('-') && input.image.startsWith('-')) throw new BoundaryError('INVALID_INPUT');
    const cwd = `${input.root.replace(/\/+$/, '')}/${input.contextPath.replace(/^\/+/, '')}`;
    let dispatched = false;
    const transport = await directConnection(config, input, signal);
    try {
      // Tool detection: docker first, buildah fallback (upstream imageToolRegistry order).
      const docker = await runCli('docker', ['--version'], cwd, '/usr/bin:/usr/local/bin:/bin', signal, 10_000);
      let tool: 'docker' | 'buildah' | undefined = docker.found && docker.code === 0 ? 'docker' : undefined;
      if (!tool) {
        const buildah = await runCli('buildah', ['--version'], cwd, '/usr/bin:/usr/local/bin:/bin', signal, 10_000);
        if (buildah.found && buildah.code === 0) tool = 'buildah';
      }
      if (!tool) return { outcome: 'failed', code: 'CLI_NOT_FOUND', built: false, pushed: false };
      const bin = tool === 'docker' ? 'docker' : 'buildah';
      const buildArgs = tool === 'docker' ? ['build', '-t', input.image, '.'] : ['bud', '-t', input.image, '.'];
      const build = await runCli(bin, buildArgs, cwd, '/usr/bin:/usr/local/bin:/bin', signal, 240_000);
      if (build.code !== 0) return { outcome: 'failed', code: 'STATE_UNAVAILABLE', built: false, pushed: false };
      if (!dispatched) beforeDispatch();
      dispatched = true; // from here the chain has touched external state; late failures stay reported
      const push = await runCli(bin, ['push', input.image], cwd, '/usr/bin:/usr/local/bin:/bin', signal, 120_000);
      if (push.code !== 0) return { outcome: 'unknown', code: 'STATE_UNAVAILABLE', built: true, pushed: false };
      if (signal.aborted || Date.now() >= input.notAfter) return { outcome: 'unknown', code: 'OPERATION_UNKNOWN', built: true, pushed: true };
      // kubectl-run-shaped Pod: labels run=<name> and one container named like kubectl does.
      const pod = JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: input.name, namespace: input.target.namespace, labels: { run: input.name } },
        spec: { containers: [{ name: input.name, image: input.image }] } });
      const url = new URL(`/api/v1/namespaces/${input.target.namespace}/pods`, transport.server);
      url.search = '?fieldManager=kubectl-run&fieldValidation=Strict';
      const created = await onceRequest<ImageRunResult | undefined>(transport, url, 'POST', 'application/json', 201, Buffer.from(pod), signal, undefined,
        (code: ErrorCode) => ({ outcome: 'unknown', code, built: true, pushed: true }),
        (_value, raw) => {
          const metadata = documentProperty(parseDocumentJson(raw), 'metadata'), uid = documentString(documentProperty(metadata, 'uid')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          return uid && rv && documentString(documentProperty(parseDocumentJson(raw), 'kind')) === 'Pod' && documentString(documentProperty(metadata, 'name')) === input.name
            ? { outcome: 'accepted', built: true, pushed: true, podUid: uid, podResourceVersion: rv } : undefined;
        });
      return created ?? { outcome: 'unknown', code: 'OPERATION_UNKNOWN', built: true, pushed: true };
    } catch (error) {
      return { outcome: dispatched ? 'unknown' : 'failed', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE',
        ...(dispatched ? { built: true } : {}) };
    } finally { transport.ca?.fill(0); }
  };
}
