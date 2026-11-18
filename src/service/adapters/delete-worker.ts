import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { isolatedKubectlEnvironment, verifyKubectlVersion } from '../queries/kubectl-plan.ts';
import { validateKubectlSnapshot } from '../queries/kubectl-configuration.ts';
import { deleteCommand, deleteWorkerDeadlineMs, parseDeleteWorkerStart } from '../operations/delete-worker-protocol.ts';
import type { DeleteWorkerResult } from '../operations/delete-worker-protocol.ts';

function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
// WRITE worker only. Not imported by queries or any automatic functional test.
async function command(executable: 'kubectl' | '/usr/bin/mkfifo', args: readonly string[], home: string, path: string, signal: AbortSignal, maximum: number, input?: Buffer) {
  active(signal);
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, detached: true, cwd: home, env: isolatedKubectlEnvironment(home, path), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0, errorBytes = 0, failure: BoundaryError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Only the owned new group. */ } } };
    const stop = (code: 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE') => { if (failure) return; failure = new BoundaryError(code); kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500); };
    const abort = () => stop('QUERY_CANCELLED'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > maximum) stop('BUDGET_EXCEEDED'); else if (!failure) out.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.byteLength; if (errorBytes > 64_000) stop('BUDGET_EXCEEDED'); else if (!failure) err.push(chunk); });
    child.stdout.on('error', () => stop('STATE_UNAVAILABLE')); child.stderr.on('error', () => stop('STATE_UNAVAILABLE')); child.stdin.on('error', () => stop('STATE_UNAVAILABLE'));
    child.once('error', error => { failure ??= new BoundaryError('code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE'); });
    child.once('close', code => {
      if (force) { kill('SIGKILL'); clearTimeout(force); } signal.removeEventListener('abort', abort);
      if (failure) reject(failure); else if (code === null) reject(new BoundaryError('STATE_UNAVAILABLE')); else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input);
  });
}
async function writeSnapshot(path: string, bytes: Uint8Array, owned: { ino: bigint; dev: bigint }, signal: AbortSignal) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const pause = async () => { try { await delay(10, undefined, { signal }); } catch { active(signal); throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); } };
  try {
    while (!file) {
      active(signal); try { file = await open(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); await pause(); }
    }
    const info = await file.stat({ bigint: true }); if (!info.isFIFO() || info.ino !== owned.ino || info.dev !== owned.dev) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    let offset = 0;
    while (offset < bytes.byteLength) {
      active(signal); try { const result = await file.write(bytes.subarray(offset, offset + 4096)); if (result.bytesWritten <= 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); offset += result.bytesWritten; }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EAGAIN') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); await pause(); }
    }
  } finally { await file?.close(); }
}
function resultOf(output: { code: number; stdout: Buffer; stderr: string }, start: ReturnType<typeof parseDeleteWorkerStart>): DeleteWorkerResult {
  if (output.code !== 0) {
    // CLI stderr is not an authenticated structured API result. Even a familiar reason
    // string cannot prove a DELETE was rejected rather than accepted before a later error.
    return { protocol: 1, kind: 'delete-result', outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout));
    const status = z.object({ apiVersion: z.literal('v1'), kind: z.literal('Status'), status: z.literal('Success') }).safeParse(value);
    const ref = start.parameters.reference;
    const object = z.object({ apiVersion: z.literal(ref.type.group ? `${ref.type.group}/${ref.type.version}` : ref.type.version), kind: z.literal(ref.type.kind),
      metadata: z.object({ uid: z.literal(ref.uid), name: z.literal(ref.name), namespace: ref.namespace ? z.literal(ref.namespace) : z.undefined() }) }).safeParse(value);
    if (status.success || object.success) return { protocol: 1, kind: 'delete-result', outcome: 'accepted' };
  } catch { /* Raw stdout/errors never leave this worker. */ }
  return { protocol: 1, kind: 'delete-result', outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
}
export async function runDeleteWorker(): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24' || !process.connected || !process.send || !((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) { process.exitCode = 1; return; }
  const controller = new AbortController(), disconnect = () => controller.abort();
  let received = false, finish: (() => void) | undefined;
  const finished = new Promise<void>(resolve => { finish = resolve; }), deadline = setTimeout(disconnect, deleteWorkerDeadlineMs);
  process.on('disconnect', disconnect); process.on('SIGTERM', disconnect); process.on('SIGINT', disconnect);
  async function execute(input: unknown) {
    let home: string | undefined, fifo: string | undefined, owned: { ino: bigint; dev: bigint } | undefined, snapshot: Uint8Array | undefined, dispatched = false;
    let result: DeleteWorkerResult;
    try {
      active(controller.signal); const start = parseDeleteWorkerStart(input); snapshot = start.snapshot; validateKubectlSnapshot(snapshot, start.target);
      if (Date.now() >= start.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      home = await mkdtemp(join(tmpdir(), 'oc-k8s-delete-')); await chmod(home, 0o700); active(controller.signal);
      const version = await command('kubectl', ['--profile=none', '--v=0', 'version', '--client', '--output=json'], home, start.path, controller.signal, 16_000);
      if (version.code !== 0) throw new BoundaryError('CLI_INCOMPATIBLE'); verifyKubectlVersion(version.stdout.toString('utf8'));
      fifo = join(home, 'configuration.pipe'); const creation = await command('/usr/bin/mkfifo', ['-m', '600', fifo], home, start.path, controller.signal, 1024);
      if (creation.code !== 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      const info = await lstat(fifo, { bigint: true }); if (!info.isFIFO() || (info.mode & 0o777n) !== 0o600n) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); owned = { ino: info.ino, dev: info.dev };
      active(controller.signal); if (Date.now() >= start.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      const plan = deleteCommand(start, fifo), pipeController = new AbortController(), signal = AbortSignal.any([controller.signal, pipeController.signal]);
      dispatched = true; // From this point, any unclassified failure may have reached the API.
      const writing = command('kubectl', plan.args, home, start.path, signal, 2_000_000, plan.input).finally(() => pipeController.abort());
      const configuration = writeSnapshot(fifo, snapshot, owned, signal).catch(error => { pipeController.abort(); throw error; });
      const [output, config] = await Promise.allSettled([writing, configuration]);
      if (output.status === 'rejected' || (config.status === 'rejected' && output.value.code === 0)) throw new BoundaryError('OPERATION_UNKNOWN');
      result = resultOf(output.value, start);
    } catch (error) { result = { protocol: 1, kind: 'delete-result', outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }; }
    finally {
      snapshot?.fill(0);
      if (fifo && owned) { try { const info = await lstat(fifo, { bigint: true }); if (info.isFIFO() && info.ino === owned.ino && info.dev === owned.dev) await unlink(fifo); } catch { /* Preserve replacements. */ } }
      if (home) { try { await rmdir(home); } catch { /* Exact owned empty directory only, never recursive. */ } }
    }
    clearTimeout(deadline); process.removeListener('message', receive); process.removeListener('disconnect', disconnect); process.removeListener('SIGTERM', disconnect); process.removeListener('SIGINT', disconnect);
    if (process.connected && process.send) await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 500); try { process.send?.(result, () => { clearTimeout(timeout); resolve(); }); } catch { clearTimeout(timeout); resolve(); } });
    if (process.connected) { try { process.disconnect(); } catch { /* Already gone. */ } } finish?.();
  }
  const receive = (input: unknown) => { if (received) { disconnect(); return; } received = true; void execute(input); };
  process.on('message', receive); controller.signal.addEventListener('abort', () => { if (!received) { received = true; void execute(undefined); } }, { once: true });
  if (!process.connected) disconnect(); await finished;
}
