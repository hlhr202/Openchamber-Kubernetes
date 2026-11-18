import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { mergeConfigSources, publicConfigSnapshot } from './kubeconfig.ts';
import type { ConfigInput } from './kubeconfig.ts';
import type { PrivateMergedConfig } from './kubeconfig.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { readConfigSelection } from '../../shared/configuration.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { defaultConfigPaths } from './config-discovery.ts';
import type { DefaultConfigPaths } from './config-discovery.ts';

export function configurationIdentity(key: Uint8Array, inputs: readonly ConfigInput[]): string {
  if (key.byteLength < 32) throw new BoundaryError('INVALID_INPUT');
  // A per-service private HMAC key prevents exposing a raw low-entropy credential/file hash.
  return `config-${createHmac('sha256', key).update(JSON.stringify(inputs)).digest('hex')}`;
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED');
}

async function readBounded(path: string, signal?: AbortSignal): Promise<ConfigInput | null> {
  const limit = 2_000_000;
  try {
    requireActive(signal);
    const canonical = await realpath(path);
    requireActive(signal);
    // Reject FIFO/device input without blocking open; do not follow a replaced canonical symlink.
    const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      requireActive(signal);
      if (!before.isFile() || before.size > BigInt(limit)) throw new BoundaryError('BUDGET_EXCEEDED');
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total <= limit) {
        requireActive(signal);
        const result = await file.read(buffer, total, buffer.length - total, total);
        if (!result.bytesRead) break;
        total += result.bytesRead;
        if (total > limit) throw new BoundaryError('BUDGET_EXCEEDED');
      }
      const after = await file.stat({ bigint: true });
      const current = await stat(canonical, { bigint: true });
      requireActive(signal);
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || before.ino !== after.ino || current.ino !== after.ino || current.dev !== after.dev
        || await realpath(path) !== canonical) throw new BoundaryError('CONFIG_CHANGED');
      return { sourcePath: canonical, originPath: path, content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)) };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new BoundaryError('CONFIG_UNREADABLE');
  }
}

export function resolveConfigSelection(value: unknown, defaults: DefaultConfigPaths) {
  const selection = readConfigSelection(value);
  const paths = selection.mode === 'default' ? defaultConfigPaths(defaults) : selection.mode === 'file' ? [selection.path] : selection.paths;
  if (paths.some(path => !isAbsolute(path))) throw new BoundaryError('INVALID_INPUT');
  return Object.freeze({ mode: selection.mode, orderedPaths: Object.freeze([...new Set(paths.map(path => posix.normalize(path)))]) });
}

type ConfigFileReader = (path: string, signal?: AbortSignal) => Promise<ConfigInput | null>;

async function readSelection(selection: ReturnType<typeof resolveConfigSelection>, key: Uint8Array, readFile: ConfigFileReader, signal?: AbortSignal) {
  requireActive(signal);
  const inputs: ConfigInput[] = [], missing: string[] = [];
  let bytes = 0;
  for (const path of selection.orderedPaths) {
    requireActive(signal);
    const input = await readFile(path, signal);
    if (input) {
      bytes += Buffer.byteLength(input.content);
      if (bytes > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
      inputs.push(input);
    } else {
      if (selection.mode === 'file') throw new BoundaryError('CONFIG_NOT_FOUND');
      missing.push(path);
    }
  }
  requireActive(signal);
  const merged = mergeConfigSources(inputs);
  const identityInputs = [{ sourcePath: 'source-selection', content: JSON.stringify({ ...selection, missing }) }, ...inputs];
  const configIdentity = configurationIdentity(key, identityInputs);
  return { merged, publicRead: { status: inputs.length ? 'ready' as const : 'missing' as const, snapshot: publicConfigSnapshot(merged, configIdentity),
    sources: { mode: selection.mode, selectedCount: selection.orderedPaths.length, loadedCount: inputs.length, missingCount: missing.length } } };
}

// Creating a reader performs no file I/O. One private key per service keeps identities stable across
// explicit selections, without retaining repositories/results or making a global current selection.
export function createConfigReader(defaults: DefaultConfigPaths, readFile: ConfigFileReader = readBounded,
  transportCredentials: (config: PrivateMergedConfig, identity: string, signal?: AbortSignal, target?: TargetIdentity) => PrivateMergedConfig | Promise<PrivateMergedConfig> = config => config,
  rejectCredentials: (config: PrivateMergedConfig, identity: string) => void = () => {}) {
  const defaultPaths = defaultConfigPaths(defaults);
  const key = randomBytes(32);
  return {
    selectionKey(selection: ConfigSelection): string {
      return configurationIdentity(key, [{ sourcePath: 'selection', content: JSON.stringify(resolveConfigSelection(selection, defaultPaths)) }]);
    },
    async read(selection: ConfigSelection, signal?: AbortSignal) {
      return (await readSelection(resolveConfigSelection(selection, defaultPaths), key, readFile, signal)).publicRead;
    },
    async privateRead(selection: ConfigSelection, expectedIdentity: string, signal?: AbortSignal) {
      const result = await readSelection(resolveConfigSelection(selection, defaultPaths), key, readFile, signal);
      if (result.publicRead.snapshot.configIdentity !== expectedIdentity) throw new BoundaryError('STALE_TARGET');
      return result; // Server-only, ephemeral. Never serialize this through a public route.
    },
    async transportRead(selection: ConfigSelection, expectedIdentity: string, signal?: AbortSignal, target?: TargetIdentity) {
      const result = await readSelection(resolveConfigSelection(selection, defaultPaths), key, readFile, signal);
      if (result.publicRead.snapshot.configIdentity !== expectedIdentity) throw new BoundaryError('STALE_TARGET');
      const merged = await transportCredentials(result.merged, expectedIdentity, signal, target);
      requireActive(signal);
      // Cloud auth may have refreshed its own cache, but must not publish credentials for changed sources.
      if (merged !== result.merged) {
        const fresh = await readSelection(resolveConfigSelection(selection, defaultPaths), key, readFile, signal);
        if (fresh.publicRead.snapshot.configIdentity !== expectedIdentity) throw new BoundaryError('STALE_TARGET');
      }
      return { ...result, merged };
    },
    credentialsRejected(config: PrivateMergedConfig, identity: string) { rejectCredentials(config, identity); },
  };
}
