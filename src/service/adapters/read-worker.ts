import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { validateKubectlSnapshot } from '../queries/kubectl-configuration.ts';
import { isolatedKubectlEnvironment, kubectlFailureStatus, kubectlReadArguments, kubectlRetryAfterMs, verifyKubectlVersion } from '../queries/kubectl-plan.ts';
import { createReadWorkerState, parseReadWorkerStart, readWorkerDeadlineMs, readWorkerFailure } from '../queries/read-worker-protocol.ts';
import type { ReadWorkerResult } from '../queries/read-worker-protocol.ts';
import { watchAckSchema, logFollowWorkerDeadlineMs } from '../queries/read-worker-protocol.ts';

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof BoundaryError ? signal.reason : new BoundaryError('QUERY_CANCELLED');
}

// Private to this read-only worker. No HTTP/argv route can choose the executable or arguments.
async function command(executable: 'kubectl' | '/usr/bin/mkfifo', args: readonly string[], home: string, path: string, signal: AbortSignal, maximumBytes: number, stream?: (bytes: Uint8Array) => Promise<void>) {
  requireActive(signal);
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, detached: true, cwd: home,
      env: isolatedKubectlEnvironment(home, path), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0, failure: BoundaryError | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    let delivery = Promise.resolve();
    const kill = (name: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Only the new owned read group; gone is harmless. */ } }
    };
    const stop = (error: BoundaryError) => {
      if (failure) return;
      failure = error; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 500);
    };
    const abort = () => { try { requireActive(signal); } catch (error) { stop(error instanceof BoundaryError ? error : new BoundaryError('QUERY_CANCELLED')); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (bytes: Buffer) => {
      outputBytes += bytes.byteLength;
      if (outputBytes > maximumBytes) stop(new BoundaryError('BUDGET_EXCEEDED'));
      else if (!failure && stream) {
        child.stdout.pause();
        delivery = delivery.then(async () => { for (let offset = 0; offset < bytes.length; offset += 16_384) { requireActive(signal); await stream(bytes.subarray(offset, offset + 16_384)); } })
          .then(() => { if (!failure) child.stdout.resume(); }, error => stop(error instanceof BoundaryError ? error : new BoundaryError('STATE_UNAVAILABLE')));
      } else if (!failure) stdout.push(bytes);
    });
    child.stderr.on('data', (bytes: Buffer) => {
      errorBytes += bytes.byteLength;
      if (errorBytes > 64_000) stop(new BoundaryError('BUDGET_EXCEEDED'));
      else if (!failure) stderr.push(bytes);
    });
    child.stdout.on('error', () => stop(new BoundaryError('STATE_UNAVAILABLE')));
    child.stderr.on('error', () => stop(new BoundaryError('STATE_UNAVAILABLE')));
    child.once('error', error => {
      failure ??= new BoundaryError(executable === '/usr/bin/mkfifo' ? 'READ_TRANSPORT_UNAVAILABLE' : 'code' in error && error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'STATE_UNAVAILABLE');
    });
    child.once('close', code => { void delivery.then(() => {
      if (force) { kill('SIGKILL'); clearTimeout(force); } // Do not cancel escalation merely because the leader closed its pipes.
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === null) reject(new BoundaryError('STATE_UNAVAILABLE'));
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    }); });
  });
}

// POSIX FIFO rendezvous without a blocking filesystem open or persisted credential file.
// ENXIO/EAGAIN waits are bounded by the worker's independent deadline/cancellation signal.
async function writeSnapshot(path: string, input: Uint8Array, identity: { ino: bigint; dev: bigint }, signal: AbortSignal): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const pause = async () => { try { await delay(10, undefined, { signal }); } catch { requireActive(signal); throw new BoundaryError('STATE_UNAVAILABLE'); } };
  try {
    while (!file) {
      requireActive(signal);
      try { file = await open(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
        await pause();
      }
    }
    const current = await file.stat({ bigint: true });
    if (!current.isFIFO() || current.ino !== identity.ino || current.dev !== identity.dev) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    let offset = 0;
    while (offset < input.byteLength) {
      requireActive(signal);
      try {
        const result = await file.write(input.subarray(offset, offset + 4096));
        if (result.bytesWritten <= 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
        offset += result.bytesWritten;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EAGAIN') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
        await pause();
      }
    }
  } finally { await file?.close(); }
}

// Only the explicit same-bundle worker mode invokes this. Importing the module is inert.
export async function runReadWorker(): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24' || !process.connected || !process.send
    || !((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) { process.exitCode = 1; return; }
  const state = createReadWorkerState(), controller = new AbortController();
  let ack: { sequence: number; resolve: () => void; reject: (error: BoundaryError) => void } | undefined, chunkSequence = 0;
  const sendChunk = async (body: Uint8Array) => {
    requireActive(controller.signal);
    if (ack || ++chunkSequence > 2048) throw new BoundaryError('BUDGET_EXCEEDED');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { ack = undefined; reject(new BoundaryError('QUERY_CANCELLED')); };
      controller.signal.addEventListener('abort', abort, { once: true });
      const done = () => controller.signal.removeEventListener('abort', abort);
      ack = { sequence: chunkSequence, resolve: () => { done(); resolve(); }, reject: error => { done(); reject(error); } };
      try { process.send?.({ protocol: 1, kind: 'watch-chunk', sequence: chunkSequence, body }, (error: Error | null) => { if (error) { const pending = ack; ack = undefined; pending?.reject(new BoundaryError('STATE_UNAVAILABLE')); } }); }
      catch { const pending = ack; ack = undefined; pending?.reject(new BoundaryError('STATE_UNAVAILABLE')); }
    });
  };
  let completed: (() => void) | undefined, started = false;
  const finished = new Promise<void>(resolve => { completed = resolve; });
  const stop = (code: 'QUERY_CANCELLED' | 'QUERY_TIMEOUT' | 'INVALID_INPUT') => {
    if (state.stop(code)) controller.abort(new BoundaryError(code));
  };
  const disconnect = () => stop('QUERY_CANCELLED'); let deadline = setTimeout(() => stop('QUERY_TIMEOUT'), readWorkerDeadlineMs);
  process.on('disconnect', disconnect);
  process.on('SIGTERM', disconnect); process.on('SIGINT', disconnect);
  async function execute(message: unknown) {
    let home: string | undefined, fifo: string | undefined, owned: { ino: bigint; dev: bigint } | undefined, snapshot: Uint8Array | undefined;
    let result: ReadWorkerResult;
    try {
      requireActive(controller.signal);
      const start = parseReadWorkerStart(message);
      if (start.request.purpose === 'pod-log-follow') { clearTimeout(deadline); deadline = setTimeout(() => stop('QUERY_TIMEOUT'), logFollowWorkerDeadlineMs); }
      snapshot = start.snapshot;
      validateKubectlSnapshot(snapshot, start.request.target);
      if (start.request.purpose === 'resource-wide' || start.request.purpose === 'resource-describe' || start.request.purpose === 'custom-wide' || start.request.purpose === 'custom-describe' || start.request.purpose === 'cluster-info') {
        // Fail closed before any CLI. Cache BasePath and explicit diskv TempDir descend from a non-directory device.
        const sink = await lstat('/dev/null', { bigint: true });
        if (!sink.isCharacterDevice() || sink.isSymbolicLink() || sink.uid !== 0n || await realpath('/dev/null') !== '/dev/null') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      }
      requireActive(controller.signal);
      home = await mkdtemp(join(tmpdir(), 'oc-k8s-read-')); await chmod(home, 0o700);
      requireActive(controller.signal);
      const version = await command('kubectl', ['--profile=none', '--v=0', 'version', '--client', '--output=json'], home, start.path, controller.signal, 16_000);
      if (version.code !== 0) throw new BoundaryError('CLI_INCOMPATIBLE');
      verifyKubectlVersion(version.stdout.toString('utf8'));
      fifo = join(home, 'configuration.pipe');
      const creation = await command('/usr/bin/mkfifo', ['-m', '600', fifo], home, start.path, controller.signal, 1024);
      if (creation.code !== 0) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      const info = await lstat(fifo, { bigint: true });
      if (!info.isFIFO() || (info.mode & 0o777n) !== 0o600n) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      owned = { ino: info.ino, dev: info.dev };
      requireActive(controller.signal);
      const pipeController = new AbortController(), signal = AbortSignal.any([controller.signal, pipeController.signal]);
      const reading = command('kubectl', kubectlReadArguments(start.request, fifo), home, start.path, signal, start.request.maximumBytes, start.request.purpose === 'resource-watch' || start.request.purpose === 'custom-resource-watch' || start.request.purpose === 'pod-log-follow' || start.request.purpose === 'namespace-event-watch' || start.request.purpose === 'job-pod-watch' ? sendChunk : undefined)
        .finally(() => pipeController.abort(new BoundaryError('QUERY_CANCELLED')));
      const writing = writeSnapshot(fifo, snapshot, owned, signal).catch(error => { pipeController.abort(new BoundaryError('READ_TRANSPORT_UNAVAILABLE')); throw error; });
      const [read, write] = await Promise.allSettled([reading, writing]); // Keep the worker alive until both owned sides actually settle.
      requireActive(controller.signal);
      if (read.status === 'rejected') throw read.reason;
      if (read.value.code === 0 && write.status === 'rejected') throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      const status = read.value.code === 0 ? 200 : kubectlFailureStatus(read.value.stderr);
      const retryAfterMs = status === 429 ? kubectlRetryAfterMs(read.value.stderr) : undefined;
      result = { protocol: 1, ok: true, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), body: status === 200 ? new Uint8Array(read.value.stdout) : new Uint8Array() };
    } catch (error) { result = readWorkerFailure(error); }
    finally {
      snapshot?.fill(0);
      if (fifo && owned) {
        try { const current = await lstat(fifo, { bigint: true }); if (current.isFIFO() && current.ino === owned.ino && current.dev === owned.dev) await unlink(fifo); }
        catch { /* Preserve replacements/unexpected files; no recursive removal. */ }
      }
      if (home) { try { await rmdir(home); } catch { /* Only the exact owned empty directory; never read/remove unexpected content. */ } }
    }
    if (state.failure) result = readWorkerFailure(new BoundaryError(state.failure));
    state.close(); clearTimeout(deadline);
    process.removeListener('message', receive); process.removeListener('disconnect', disconnect);
    process.removeListener('SIGTERM', disconnect); process.removeListener('SIGINT', disconnect);
    // No stdout, stderr, config, raw CLI error or resource output goes to logs.
    if (process.connected && process.send) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 500);
        try { process.send?.(result, () => { clearTimeout(timeout); resolve(); }); }
        catch { clearTimeout(timeout); resolve(); }
      });
    }
    if (process.connected) { try { process.disconnect(); } catch { /* Already disconnected. */ } }
    completed?.();
  }
  const receive = (message: unknown) => {
    const parsed = watchAckSchema.safeParse(message);
    if (parsed.success) {
      if (!ack || parsed.data.sequence !== ack.sequence) { stop('INVALID_INPUT'); return; }
      const pending = ack; ack = undefined; pending.resolve(); return;
    }
    if (!state.start()) { stop('INVALID_INPUT'); return; }
    started = true;
    void execute(message);
  };
  process.on('message', receive);
  // Closing the parent before the first packet must not leave a waiting worker alive.
  controller.signal.addEventListener('abort', () => {
    if (state.phase === 'stopping' && !started) { started = true; void execute(undefined); }
  }, { once: true });
  if (!process.connected) disconnect();
  await finished;
}
