import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, join } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { namespaceDocument } from '../operations/namespace-document.ts';
import { namespaceCreateDocument } from '../operations/namespace-create-document.ts';
import { contextDocument } from '../operations/context-document.ts';
import { contextDeleteDescription, contextDeleteSourcesDescription, deleteEntryDocument } from '../operations/context-delete-document.ts';
import type { EntrySection } from '../operations/context-delete-document.ts';
import { resolveConfigSelection } from '../queries/config-source.ts';
import { defaultConfigPaths } from '../queries/config-discovery.ts';
import type { DefaultConfigPaths } from '../queries/config-discovery.ts';
import { mergeConfigSources, parseConfig } from '../queries/kubeconfig.ts';
import type { ConfigurationSource } from '../../shared/configuration-source-protocol.ts';
import type { ContextDeletionSource } from '../../shared/context-delete-protocol.ts';

export type NamespaceFilePlan = { readonly path: string; readonly version: string; readonly intended: string; readonly previous: string; readonly namespace: string; readonly contextName?: string; readonly externalCurrent?: boolean; readonly createContext?: boolean };
export type NamespaceFileBundle = { readonly plan: NamespaceFilePlan; readonly contextName: string; readonly contextOrigin: string; readonly contextAction: 'update' | 'create'; readonly sources: readonly ConfigurationSource[] };
export type ContextFilePlan = { readonly path: string; readonly version: string; readonly intended: string; readonly previous: string; readonly context: string; readonly externalContext?: boolean; readonly unchanged?: boolean };
export type ContextFileBundle = { readonly plan: ContextFilePlan; readonly previous: string; readonly contextOrigin: string; readonly sources: readonly ConfigurationSource[] };
export type EntryFilePlan = { readonly path: string; readonly version: string; readonly intended: string; readonly previousBody: string; readonly section: EntrySection; readonly name: string; readonly deletingContext: string; readonly externalContext?: boolean };
export type ContextDeletionBundle = { readonly path: string; readonly version: string; readonly context: string; readonly sources: readonly ContextDeletionSource[];
  readonly description: ReturnType<typeof contextDeleteSourcesDescription>; readonly plans: readonly (EntryFilePlan | null)[];
  readonly checkpoints: readonly (readonly { readonly path: string; readonly content: string | null }[])[] };
export type NamespaceFileResult = { readonly phase: 'succeeded' | 'failed' | 'unknown'; readonly cleanup: 'none' | 'manual-check'; readonly result?: 'changed' | 'unchanged'; readonly versionAfter?: string; readonly code?: ErrorCode };
function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
type Stamp = { ino: bigint; dev: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint; uid: bigint; gid: bigint; nlink: bigint };
const stamp = (value: Stamp) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode, value.uid, value.gid, value.nlink].map(String).join(':');
async function removeOwnedStaging(temporary: string, owned: { ino: bigint; dev: bigint } | undefined): Promise<boolean> {
  if (!owned) return false;
  try {
    const value = await lstat(temporary, { bigint: true });
    if (!value.isFile() || value.ino !== owned.ino || value.dev !== owned.dev || value.nlink !== 1n) return false;
    await unlink(temporary); return true;
  } catch { return false; }
}

// WRITE filesystem adapter. No I/O until explicit prepare/submit; never called by tests.
export function createNamespaceFileAdapter(defaults: DefaultConfigPaths) {
  const defaultPaths = defaultConfigPaths(defaults);
  const key = randomBytes(32), hash = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  async function parents(path: string, signal: AbortSignal) {
    const values: string[] = []; let directory = dirname(path);
    while (true) {
      active(signal); const value = await lstat(directory, { bigint: true });
      if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o022n) !== 0n || (value.uid !== 0n && value.uid !== BigInt(process.getuid?.() ?? -1))) throw new BoundaryError('CONFIG_UNREADABLE');
      values.push(`${directory}:${value.dev}:${value.ino}`);
      if (directory === '/') break; directory = dirname(directory);
    }
    return values.join('\n');
  }
  async function snapshot(path: string, signal: AbortSignal, requireWritable = true) {
    active(signal);
    if (!isAbsolute(path) || normalize(path) !== path || path.startsWith('//') || await realpath(path) !== path) throw new BoundaryError('CONFIG_UNREADABLE');
    const parent = await parents(path, signal), file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(2_000_001);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o7133n) !== 0n || (requireWritable && (before.mode & 0o200n) === 0n) || before.size > 2_000_000n) throw new BoundaryError('CONFIG_UNREADABLE');
      let offset = 0;
      while (offset < bytes.length) { active(signal); const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true }); active(signal);
      if (stamp(before) !== stamp(after) || stamp(current) !== stamp(after) || current.isSymbolicLink() || await realpath(path) !== path || await parents(path, signal) !== parent) throw new BoundaryError('CONFIG_CHANGED');
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
      return { path, body, mode: Number(before.mode & 0o777n), uid: Number(before.uid), gid: Number(before.gid), parent, version: hash(`${path}\n${stamp(before)}\n${body}`) };
    } finally { bytes.fill(0); await file.close(); }
  }
  function pathFor(selection: ConfigSelection): string {
    if (selection.mode === 'merge') throw new BoundaryError('INVALID_INPUT');
    if (selection.mode === 'file') return selection.path;
    const path = defaultPaths[0];
    if (defaultPaths.length !== 1 || !path) throw new BoundaryError('INVALID_INPUT');
    return path; // Legacy single-source helpers must not silently pick one member of a default merge.
  }
  async function contextSources(paths: readonly string[], context: string, signal: AbortSignal) {
    const sources: ConfigurationSource[] = [], values: Awaited<ReturnType<typeof snapshot>>[] = []; let bytes = 0;
    for (const path of paths) {
      active(signal);
      try {
        const value = await snapshot(path, signal, false); bytes += Buffer.byteLength(value.body);
        if (bytes > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        const parsed = parseConfig(value.body); values.push(value);
        sources.push(Object.freeze({ path, status: 'present', version: value.version, currentContext: parsed['current-context'] ?? '', definesContext: !!parsed.contexts?.some(value => value.name === context) }));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        try { await lstat(path); throw new BoundaryError('CONFIG_UNREADABLE'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        sources.push(Object.freeze({ path, status: 'missing', version: null, currentContext: '', definesContext: false }));
      }
    }
    active(signal); return { sources: Object.freeze(sources), values };
  }
  return {
    async verifyCommitted(plan: Pick<NamespaceFilePlan, 'path' | 'intended'>, signal: AbortSignal): Promise<void> {
      try {
        const value = await snapshot(plan.path, signal);
        if (hash(value.body) !== plan.intended) throw new BoundaryError('CONFIG_CHANGED'); active(signal);
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async inspect(selection: ConfigSelection, target: TargetIdentity, namespace: string, signal: AbortSignal): Promise<NamespaceFilePlan> {
      try {
        const value = await snapshot(pathFor(selection), signal), next = namespaceDocument(value.body, target.context, target.namespace, namespace);
        if (Buffer.byteLength(next) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        return Object.freeze({ path: value.path, version: value.version, intended: hash(next), previous: target.namespace, namespace });
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async inspectContext(selection: ConfigSelection, previous: string, context: string, signal: AbortSignal): Promise<ContextFilePlan> {
      try {
        const value = await snapshot(pathFor(selection), signal), next = contextDocument(value.body, previous, context);
        if (Buffer.byteLength(next) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        return Object.freeze({ path: value.path, version: value.version, intended: hash(next), previous, context });
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async inspectContextSources(selection: ConfigSelection, context: string, signal: AbortSignal): Promise<ContextFileBundle> {
      try {
        const rawPaths = selection.mode === 'default' ? defaultPaths : selection.mode === 'file' ? [selection.path] : selection.paths;
        if (rawPaths.some(path => normalize(path) !== path)) throw new BoundaryError('INVALID_INPUT');
        const paths = resolveConfigSelection(selection, defaultPaths).orderedPaths, { sources, values } = await contextSources(paths, context, signal);
        const merged = mergeConfigSources(values.map(value => ({ sourcePath: value.path, originPath: value.path, content: value.body }))), target = merged.contexts.get(context);
        if (!target) throw new BoundaryError('NOT_FOUND');
        const destination = values[0]; if (!destination) throw new BoundaryError('CONFIG_NOT_FOUND'); // GetDefaultFilename: first existing source, NOT context origin.
        const previous = parseConfig(destination.body)['current-context'] ?? '', unchanged = merged.currentContext === context;
        if (!unchanged && (await snapshot(destination.path, signal)).version !== destination.version) throw new BoundaryError('CONFIG_CHANGED');
        const next = unchanged ? destination.body : contextDocument(destination.body, previous, context, true);
        if (Buffer.byteLength(next) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        const plan: ContextFilePlan = Object.freeze({ path: destination.path, version: destination.version, previous, context, intended: hash(next), externalContext: true, unchanged });
        return Object.freeze({ plan, previous: merged.currentContext, contextOrigin: target.sourcePath, sources });
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async inspectNamespaceSources(selection: ConfigSelection, target: { readonly context: string; readonly namespace: string; readonly contextMissing?: boolean }, namespace: string, signal: AbortSignal): Promise<NamespaceFileBundle> {
      try {
        const rawPaths = selection.mode === 'default' ? defaultPaths : selection.mode === 'file' ? [selection.path] : selection.paths;
        if (rawPaths.some(path => normalize(path) !== path)) throw new BoundaryError('INVALID_INPUT');
        const paths = resolveConfigSelection(selection, defaultPaths).orderedPaths, { sources, values } = await contextSources(paths, target.context, signal);
        const merged = mergeConfigSources(values.map(value => ({ sourcePath: value.path, originPath: value.path, content: value.body }))), context = merged.contexts.get(target.context);
        if (merged.currentContext !== target.context || (!context) !== (target.contextMissing === true) || (context?.value.namespace || 'default') !== target.namespace) throw new BoundaryError('STALE_TARGET');
        const destination = context ? values.find(value => value.path === context.sourcePath) : values[0]; // Existing stanza origin; missing stanza uses GetDefaultFilename/first existing source.
        if (!destination) throw new BoundaryError('CONFIG_NOT_FOUND');
        const unchanged = !!context && namespace === target.namespace; // Creation is never a same-namespace no-op, even for default.
        if (!unchanged && (await snapshot(destination.path, signal)).version !== destination.version) throw new BoundaryError('CONFIG_CHANGED');
        const next = unchanged ? destination.body : context ? namespaceDocument(destination.body, target.context, target.namespace, namespace, true)
          : namespaceCreateDocument(destination.body, target.context, namespace, true);
        if (Buffer.byteLength(next) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
        const plan: NamespaceFilePlan = Object.freeze({ path: destination.path, version: destination.version, intended: hash(next), previous: target.namespace, namespace, contextName: target.context, externalCurrent: true, ...(!context ? { createContext: true } : {}) });
        return Object.freeze({ plan, contextName: target.context, contextOrigin: context?.sourcePath ?? destination.path, contextAction: context ? 'update' as const : 'create' as const, sources });
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async verifyNamespaceSources(bundle: NamespaceFileBundle, signal: AbortSignal) {
      const current = await contextSources(bundle.sources.map(value => value.path), bundle.contextName, signal);
      if (JSON.stringify(current.sources) !== JSON.stringify(bundle.sources)) throw new BoundaryError('CONFIG_CHANGED');
    },
    async verifyNamespaceCommitted(bundle: NamespaceFileBundle, expectedVersion: string, signal: AbortSignal) {
      const value = await snapshot(bundle.plan.path, signal, false);
      if (value.version !== expectedVersion || hash(value.body) !== bundle.plan.intended) throw new BoundaryError('CONFIG_CHANGED');
      const current = await contextSources(bundle.sources.map(value => value.path), bundle.contextName, signal);
      const versions = bundle.sources.map(source => source.path === bundle.plan.path ? { ...source, version: expectedVersion } : source);
      const expected = versions.map(source => bundle.plan.createContext && source.path === bundle.plan.path ? { ...source, definesContext: true } : source);
      if (JSON.stringify(current.sources) !== JSON.stringify(expected)) throw new BoundaryError('CONFIG_CHANGED');
    },
    async verifyContextSources(bundle: ContextFileBundle, signal: AbortSignal) {
      const current = await contextSources(bundle.sources.map(value => value.path), bundle.plan.context, signal);
      if (JSON.stringify(current.sources) !== JSON.stringify(bundle.sources)) throw new BoundaryError('CONFIG_CHANGED');
    },
    async inspectContextDeletion(selection: ConfigSelection, context: string, signal: AbortSignal) {
      try {
        const value = await snapshot(pathFor(selection), signal), description = contextDeleteDescription(value.body, context), plans: (EntryFilePlan | null)[] = [];
        let body = value.body;
        for (const step of description.steps) {
          if (step.phase === 'skipped') { plans.push(null); continue; }
          const section = step.id === 'cluster' ? 'clusters' : step.id === 'user' ? 'users' : 'contexts';
          const next = deleteEntryDocument(body, section, step.name, context);
          plans.push(Object.freeze({ path: value.path, version: value.version, intended: hash(next), previousBody: hash(body), section, name: step.name, deletingContext: context })); body = next;
        }
        return { path: value.path, version: value.version, description, plans: Object.freeze(plans) };
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async inspectContextDeletionSources(selection: ConfigSelection, context: string, signal: AbortSignal): Promise<ContextDeletionBundle> {
      try {
        const rawPaths = selection.mode === 'default' ? defaultPaths : selection.mode === 'file' ? [selection.path] : selection.paths;
        if (rawPaths.some(path => normalize(path) !== path)) throw new BoundaryError('INVALID_INPUT');
        const paths = resolveConfigSelection(selection, defaultPaths).orderedPaths, original = await contextSources(paths, context, signal);
        const inputs = original.values.map(value => ({ sourcePath: value.path, originPath: value.path, content: value.body }));
        const description = contextDeleteSourcesDescription(inputs, context), targetPath = description.steps[2].path;
        const target = original.values.find(value => value.path === targetPath); if (!target) throw new BoundaryError('NOT_FOUND');
        const sources = original.sources.map(source => {
          const input = inputs.find(value => value.sourcePath === source.path), parsed = input ? parseConfig(input.content) : undefined;
          return Object.freeze({ ...source, definesCluster: !!description.cluster && !!parsed?.clusters?.some(entry => entry.name === description.cluster),
            definesUser: !!description.user && !!parsed?.users?.some(entry => entry.name === description.user) });
        });
        const checkpoint = () => Object.freeze(paths.map(path => { const input = inputs.find(value => value.sourcePath === path); return Object.freeze({ path, content: input ? hash(input.content) : null }); }));
        const checkpoints = [checkpoint()], plans: (EntryFilePlan | null)[] = [];
        for (const entry of description.steps) {
          active(signal);
          if (entry.phase === 'skipped') { plans.push(null); checkpoints.push(checkpoint()); continue; }
          const section = entry.id === 'cluster' ? 'clusters' : entry.id === 'user' ? 'users' : 'contexts';
          const merged = mergeConfigSources(inputs), origin = (section === 'clusters' ? merged.clusters : section === 'users' ? merged.users : merged.contexts).get(entry.name)?.sourcePath;
          if (origin !== entry.path) throw new BoundaryError('CONFIG_CHANGED');
          const input = inputs.find(value => value.sourcePath === origin), value = original.values.find(value => value.path === origin);
          if (!input || !value) throw new BoundaryError('CONFIG_CHANGED');
          if ((await snapshot(value.path, signal)).version !== value.version) throw new BoundaryError('CONFIG_CHANGED');
          const next = deleteEntryDocument(input.content, section, entry.name, context, true);
          plans.push(Object.freeze({ path: value.path, version: value.version, previousBody: hash(input.content), intended: hash(next), section, name: entry.name, deletingContext: context, externalContext: true }));
          input.content = next; checkpoints.push(checkpoint()); // Only the confirmed winning definition; never chase a newly exposed shadow.
        }
        const after = mergeConfigSources(inputs);
        if (after.currentContext !== description.currentContextRetained || after.contexts.has(context) !== description.contextRemains) throw new BoundaryError('CONFIG_CHANGED');
        return Object.freeze({ path: target.path, version: target.version, context, sources: Object.freeze(sources), description, plans: Object.freeze(plans), checkpoints: Object.freeze(checkpoints) });
      } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
    },
    async verifyContextDeletionSources(bundle: ContextDeletionBundle, checkpointIndex: number, versions: ReadonlyMap<string, string>, signal: AbortSignal) {
      const expected = bundle.checkpoints[checkpointIndex]; if (!expected || expected.length !== bundle.sources.length) throw new BoundaryError('STATE_UNAVAILABLE');
      const current = await contextSources(bundle.sources.map(source => source.path), bundle.context, signal);
      for (const source of current.sources) {
        const value = current.values.find(value => value.path === source.path), content = value ? hash(value.body) : null;
        if (source.version !== (versions.get(source.path) ?? null) || content !== expected.find(value => value.path === source.path)?.content) throw new BoundaryError('CONFIG_CHANGED');
      }
    },
    async rebaseEntry(plan: EntryFilePlan, expectedVersion: string, signal: AbortSignal): Promise<EntryFilePlan> {
      const value = await snapshot(plan.path, signal);
      if (value.version !== expectedVersion || hash(value.body) !== plan.previousBody) throw new BoundaryError('CONFIG_CHANGED');
      return Object.freeze({ ...plan, version: value.version }); // Only the confirmed previous successful step may explain the changed file version.
    },
    async commit(id: string, plan: NamespaceFilePlan | ContextFilePlan | EntryFilePlan, target: TargetIdentity | undefined, beforeStage: () => void, beforeCommit: () => void, signal: AbortSignal, recheckSources?: () => Promise<void>): Promise<NamespaceFileResult> {
      let temporary: string | undefined, owned: { ino: bigint; dev: bigint } | undefined, committed = false, attempted = false, stagedCreated = false;
      let result: NamespaceFileResult;
      try {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new BoundaryError('INVALID_INPUT');
        const value = await snapshot(plan.path, signal);
        if (value.version !== plan.version) throw new BoundaryError('CONFIG_CHANGED');
        if (!('context' in plan) && !('section' in plan) && !plan.contextName && !target) throw new BoundaryError('INVALID_INPUT');
        if ('namespace' in plan && plan.contextName && target && plan.contextName !== target.context) throw new BoundaryError('STALE_TARGET');
        if ('section' in plan && hash(value.body) !== plan.previousBody) throw new BoundaryError('CONFIG_CHANGED');
        const next = 'section' in plan ? deleteEntryDocument(value.body, plan.section, plan.name, plan.deletingContext, plan.externalContext === true) : 'context' in plan ? plan.unchanged ? value.body : contextDocument(value.body, plan.previous, plan.context, plan.externalContext === true)
          : plan.createContext ? namespaceCreateDocument(value.body, plan.contextName ?? '', plan.namespace, plan.externalCurrent === true)
            : namespaceDocument(value.body, plan.contextName ?? target?.context ?? '', plan.previous, plan.namespace, plan.externalCurrent === true);
        if (hash(next) !== plan.intended) throw new BoundaryError('CONFIG_CHANGED');
        active(signal);
        if (next === value.body) return { phase: 'succeeded', cleanup: 'none', result: 'unchanged', versionAfter: value.version };
        beforeStage();
        temporary = join(dirname(plan.path), `.${basename(plan.path)}.oc-k8s-${id}.tmp`);
        const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        stagedCreated = true;
        try {
          const info = await staged.stat({ bigint: true }); owned = { ino: info.ino, dev: info.dev };
          active(signal); await staged.writeFile(next, 'utf8'); await staged.chown(value.uid, value.gid); await staged.sync(); active(signal);
          if (recheckSources) await recheckSources(); active(signal);
          const current = await snapshot(plan.path, signal);
          if (current.version !== plan.version || current.parent !== value.parent) throw new BoundaryError('CONFIG_CHANGED');
          const stage = await lstat(temporary, { bigint: true });
          if (!stage.isFile() || stage.nlink !== 1n || stage.ino !== owned.ino || stage.dev !== owned.dev) throw new BoundaryError('CONFIG_CHANGED');
          beforeCommit(); attempted = true; // Irrevocable boundary: cancellation from now on cannot claim rollback.
          await rename(temporary, plan.path); committed = true;
          // Staging stays 0600 until rename; only the explicitly selected final file regains its old mode.
          await staged.chmod(value.mode); await staged.sync();
          const parent = await open(dirname(plan.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        } finally { await staged.close(); }
        // After the irrevocable replace, finish recording the actual safe file generation even if the caller cancelled.
        const after = await snapshot(plan.path, new AbortController().signal);
        if (hash(after.body) !== plan.intended) throw new BoundaryError('CONFIG_CHANGED');
        result = { phase: 'succeeded', cleanup: 'none', result: 'changed', versionAfter: after.version };
      } catch (error) {
        result = { phase: attempted ? 'unknown' : 'failed', cleanup: 'none', code: attempted ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'CONFIG_UNREADABLE' };
      } finally {
        if (temporary && stagedCreated && !committed) {
          if (!await removeOwnedStaging(temporary, owned)) result = { phase: 'unknown', cleanup: 'manual-check', code: 'OPERATION_UNKNOWN' };
        }
      }
      return result;
    },
  };
}
