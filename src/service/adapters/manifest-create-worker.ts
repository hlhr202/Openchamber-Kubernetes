// Real WRITE worker. Never imported or executed by automated functional tests or startup health.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, dnsName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson } from '../../shared/document-json.ts';
import { isolatedKubectlEnvironment, verifyKubectlVersion } from '../queries/kubectl-plan.ts';
import { validateKubectlSnapshot } from '../queries/kubectl-configuration.ts';
import { createWorkerGoSchema, createWorkerResultSchema, manifestCreateCommand, manifestCreateWorkerDeadlineMs, parseCreateWorkerStart } from '../operations/manifest-create-worker-protocol.ts';
import type { CreateWorkerResult } from '../operations/manifest-create-worker-protocol.ts';
function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
async function command(executable: 'kubectl' | '/usr/bin/mkfifo', args: readonly string[], home: string, path: string, signal: AbortSignal, maximum: number, input?: Uint8Array) {
  active(signal);
  return new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, detached: true, cwd: home, env: isolatedKubectlEnvironment(home, path), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0, errors = 0, failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Owned new process group only. */ } } };
    const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500); };
    const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > maximum) stop('BUDGET_EXCEEDED'); else if (!failure) chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.byteLength; if (errors > 64_000) stop('BUDGET_EXCEEDED'); }); // Never retain/parse sensitive CLI stderr.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => stop('STATE_UNAVAILABLE'));
    child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
    child.once('close', code => { if (force) { kill('SIGKILL'); clearTimeout(force); } signal.removeEventListener('abort', abort);
      const stdout = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
      if (failure || code === null) { stdout.fill(0); reject(failure ?? new BoundaryError('STATE_UNAVAILABLE')); } else resolve({ code, stdout }); });
    child.stdin.end(input);
  });
}
async function feedConfiguration(path: string, bytes: Uint8Array, owned: { ino: bigint; dev: bigint }, signal: AbortSignal) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const pause = async () => { try { await delay(10, undefined, { signal }); } catch { active(signal); throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); } };
  try {
    while (!file) { active(signal); try { file = await open(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); await pause(); } }
    const info = await file.stat({ bigint: true }); if (!info.isFIFO() || info.ino !== owned.ino || info.dev !== owned.dev) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    for (let offset = 0; offset < bytes.byteLength;) { active(signal); try { const result = await file.write(bytes.subarray(offset, offset + 4096)); if (result.bytesWritten <= 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); offset += result.bytesWritten; }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EAGAIN') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); await pause(); } }
  } finally { await file?.close(); }
}
function outcome(stdout: Buffer, start: ReturnType<typeof parseCreateWorkerStart>): CreateWorkerResult {
  const value = parseDocumentJson(new TextDecoder('utf-8', { fatal: true }).decode(stdout)), metadata = documentProperty(value, 'metadata'), ref = start.reference;
  const uid = documentString(documentProperty(metadata, 'uid')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
  const created = documentString(documentProperty(metadata, 'name'));
  // A generated create accepts the server-assigned name (prefix + suffix) and reports it back;
  // a named create still requires the exact intended name.
  const nameAccepted = start.generated === true ? !!created && created.length > ref.name.length && created.startsWith(ref.name) && dnsName.safeParse(created).success
    : created === ref.name;
  if (documentString(documentProperty(value, 'apiVersion')) !== (ref.type.group ? `${ref.type.group}/${ref.type.version}` : ref.type.version) || documentString(documentProperty(value, 'kind')) !== ref.type.kind
    || !nameAccepted || (ref.namespace ? documentString(documentProperty(metadata, 'namespace')) !== ref.namespace : documentProperty(metadata, 'namespace') !== undefined)
    || !uid || !rv || !boundedName.safeParse(uid).success || !boundedName.safeParse(rv).success || !created) throw new BoundaryError('OPERATION_UNKNOWN');
  return { protocol: 1, kind: 'create-result', phase: 'succeeded', uid, resourceVersion: rv, cleanup: 'none', ...(start.generated === true ? { name: created } : {}) };
}
export async function runManifestCreateWorker(): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24' || !process.connected || !process.send || !((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) { process.exitCode = 1; return; }
  const controller = new AbortController(), disconnect = () => controller.abort(); let received = false, waiting = false, grant: (() => void) | undefined, finish: (() => void) | undefined;
  const granted = new Promise<void>(resolve => { grant = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; }), deadline = setTimeout(disconnect, manifestCreateWorkerDeadlineMs);
  process.on('disconnect', disconnect); process.on('SIGTERM', disconnect); process.on('SIGINT', disconnect);
  controller.signal.addEventListener('abort', () => grant?.(), { once: true });
  async function execute(input: unknown) {
    let home: string | undefined, fifo: string | undefined, owned: { ino: bigint; dev: bigint } | undefined, snapshot: Uint8Array | undefined, body: Uint8Array | undefined, dispatched = false;
    let result: CreateWorkerResult = { protocol: 1, kind: 'create-result', phase: 'not-submitted', code: 'STATE_UNAVAILABLE', cleanup: 'none' };
    try {
      active(controller.signal); const start = parseCreateWorkerStart(input); snapshot = start.snapshot; body = start.body; validateKubectlSnapshot(snapshot, start.target);
      if (Date.now() >= start.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      home = await mkdtemp(join(tmpdir(), 'oc-k8s-create-')); await chmod(home, 0o700);
      const version = await command('kubectl', ['--profile=none', '--v=0', 'version', '--client', '--output=json'], home, start.path, controller.signal, 16_000);
      try { if (version.code !== 0) throw new BoundaryError('CLI_INCOMPATIBLE'); verifyKubectlVersion(version.stdout.toString('utf8')); } finally { version.stdout.fill(0); }
      fifo = join(home, 'configuration.pipe'); const creation = await command('/usr/bin/mkfifo', ['-m', '600', fifo], home, start.path, controller.signal, 1024); creation.stdout.fill(0);
      if (creation.code !== 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      const info = await lstat(fifo, { bigint: true }); if (!info.isFIFO() || (info.mode & 0o777n) !== 0o600n) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); owned = { ino: info.ino, dev: info.dev };
      active(controller.signal); waiting = true; process.send?.({ protocol: 1, kind: 'create-ready' }); await granted; waiting = false;
      active(controller.signal); if (Date.now() >= start.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      const pipe = new AbortController(), signal = AbortSignal.any([controller.signal, pipe.signal]); dispatched = true;
      const writing = command('kubectl', manifestCreateCommand(start, fifo), home, start.path, signal, 2_000_000, body).finally(() => pipe.abort());
      const feeding = feedConfiguration(fifo, snapshot, owned, signal).catch(error => { pipe.abort(); throw error; });
      const [output, config] = await Promise.allSettled([writing, feeding]);
      if (output.status !== 'fulfilled') throw new BoundaryError('OPERATION_UNKNOWN');
      try { if (output.value.code !== 0 || config.status !== 'fulfilled') throw new BoundaryError('OPERATION_UNKNOWN'); result = outcome(output.value.stdout, start); } finally { output.value.stdout.fill(0); }
    } catch (error) { result = { protocol: 1, kind: 'create-result', phase: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', cleanup: 'none' }; }
    finally {
      snapshot?.fill(0); body?.fill(0); let manual = false;
      if (fifo && owned) { try { const info = await lstat(fifo, { bigint: true }); if (info.isFIFO() && info.ino === owned.ino && info.dev === owned.dev) await unlink(fifo); else manual = true; } catch { manual = true; } }
      if (home) { try { await rmdir(home); } catch { manual = true; } } if (manual) result = { ...result, cleanup: 'manual-check' };
    }
    clearTimeout(deadline); process.removeListener('message', receive); process.removeListener('disconnect', disconnect); process.removeListener('SIGTERM', disconnect); process.removeListener('SIGINT', disconnect);
    const safe = createWorkerResultSchema.parse(result);
    if (process.connected && process.send) await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 500); try { process.send?.(safe, () => { clearTimeout(timeout); resolve(); }); } catch { clearTimeout(timeout); resolve(); } });
    if (process.connected) { try { process.disconnect(); } catch { /* Already gone. */ } } finish?.();
  }
  const receive = (input: unknown) => { if (!received) { received = true; void execute(input); } else if (waiting && createWorkerGoSchema.safeParse(input).success) { waiting = false; grant?.(); } else disconnect(); };
  process.on('message', receive); controller.signal.addEventListener('abort', () => { if (!received) { received = true; void execute(undefined); } }, { once: true });
  if (!process.connected) disconnect(); await finished;
}
