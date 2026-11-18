import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { projectWorkspaceRequestSchema, workspaceChunkBytes, workspaceFrameBytes, workspacePayloadBytes } from '../../shared/project-workspace-protocol.ts';
import type { ProjectWorkspaceRequest, WorkspaceEffect, WorkspaceFrame } from '../../shared/project-workspace-protocol.ts';
import { samePresentation } from '../../shared/presentation-state.ts';

export type ProjectWorkspaceRuntime = {
  invoke(method: string, args: unknown[]): Promise<{ value?: unknown; effects?: WorkspaceEffect[] }>;
  selectors(): Record<string, unknown>;
  locale(value: string): void;
  close(): void;
};
type Job = { id: string; phase: 'pending' | 'done' | 'error'; value?: unknown; effects?: WorkspaceEffect[]; error?: string };
type Viewer = {
  token: string; sequence: number; seen: number; jobs: Map<string, Job>; upload?: { id: string; bytes: number; parts: Buffer[]; received: number; expires: number };
  frame?: { id: string; data: Buffer; version: number; expires: number };
};
type Workspace = {
  id: string; directory: string; version: number; states: WorkspaceFrame['states']; ui: { revision: number; value: Record<string, unknown> };
  viewers: Map<string, Viewer>; runtime: ProjectWorkspaceRuntime;
};
// UUID v7: timestamp plus fresh randomness; workspace IDs survive iframe remounts.
function identifier(now: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.min(Math.max(0, Math.floor(now)), 0xffffffffffff), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 15); bytes[8] = 0x80 | (bytes[8]! & 63);
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function directoryKey(value: string): string {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) throw new BoundaryError('INVALID_INPUT');
  return value.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}
function jsonCopy<T>(value: T, maximum = workspaceFrameBytes): T {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > maximum) throw new BoundaryError('BUDGET_EXCEEDED');
  return JSON.parse(text) as T;
}
// The factory is injected. Pure/read-only tests never import the runtime,
// authentication, session, or write executors. Detach NEVER disposes a runtime.
export function createProjectWorkspaces(options: {
  generation: string;
  create(input: { id: string; directory: string; locale: string; preferences: unknown; emit(channel: string, ...args: unknown[]): void }): ProjectWorkspaceRuntime;
  now?: () => number;
}) {
  const now = options.now ?? Date.now, projects = new Map<string, Workspace>(), byId = new Map<string, Workspace>();
  let closed = false, pendingCommands = 0, pendingArgumentBytes = 0;
  const stateSizes = new Map<string, Map<string, number>>();
  // Serialized mirrors and transport staging are bounded separately from the
  // existing clients' own finite buffers. Never evict an old workspace to fit.
  const transientLimit = 64 * 1024 * 1024;
  const transientBytes = () => [...projects.values()].reduce((sum, project) =>
    sum + [...project.viewers.values()].reduce((size, viewer) => size + (viewer.frame?.data.length ?? 0) + (viewer.upload?.bytes ?? 0), 0), 0);
  function lookup(request: { workspace: string; viewer: string }): { workspace: Workspace; viewer: Viewer } {
    const workspace = byId.get(request.workspace), viewer = workspace?.viewers.get(request.viewer);
    if (!workspace || !viewer || !timingSafeEqual(Buffer.from(viewer.token), Buffer.from(request.viewer))) throw new BoundaryError('VIEW_EXPIRED');
    viewer.seen = now();
    return { workspace, viewer };
  }
  function sweep(viewer: Viewer) {
    if (viewer.upload && viewer.upload.expires <= now()) delete viewer.upload;
    if (viewer.frame && viewer.frame.expires <= now()) delete viewer.frame;
  }
  function read(workspace: Workspace, viewer: Viewer, request: Extract<ProjectWorkspaceRequest, { op: 'read' }>) {
    if (!request.cursor) {
      if (request.offset !== undefined) throw new BoundaryError('INVALID_INPUT');
      if (!request.initial && request.after === workspace.version) return { kind: 'unchanged', version: workspace.version };
      const states = Object.fromEntries(Object.entries(workspace.states).filter(([, state]) => request.initial || state.version > request.after));
      const value: WorkspaceFrame = { version: workspace.version, states, selectors: workspace.runtime.selectors(), ...(request.initial ? { ui: workspace.ui } : {}) };
      const data = Buffer.from(JSON.stringify(value));
      if (data.byteLength > workspaceFrameBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      if (transientBytes() - (viewer.frame?.data.length ?? 0) + data.length > transientLimit) throw new BoundaryError('QUERY_LIMIT');
      viewer.frame = { id: identifier(now()), data, version: workspace.version, expires: now() + 30_000 };
    }
    const frame = viewer.frame, offset = request.offset ?? 0;
    if (!frame || request.cursor && frame.id !== request.cursor || offset > frame.data.length || offset % workspaceChunkBytes) throw new BoundaryError('VIEW_EXPIRED');
    const end = Math.min(frame.data.length, offset + workspaceChunkBytes), data = frame.data.subarray(offset, end).toString('base64');
    if (end === frame.data.length) delete viewer.frame;
    return { kind: 'frame', id: frame.id, version: frame.version, offset, end, bytes: frame.data.length, data, complete: end === frame.data.length };
  }
  function handle(input: unknown): unknown {
    if (closed) throw new BoundaryError('SERVICE_CLOSED');
    const request = projectWorkspaceRequestSchema.parse(input);
    if (request.op === 'attach') {
      const directory = directoryKey(request.directory);
      let workspace = projects.get(directory);
      if (!workspace) {
        // Admission never silently evicts an old project's scene.
        if (projects.size >= 64) throw new BoundaryError('QUERY_LIMIT');
        const id = identifier(now());
        const sizes = new Map<string, number>();
        stateSizes.set(id, sizes);
        const pending: Omit<Workspace, 'runtime'> = { id, directory, version: 0, states: Object.create(null), ui: { revision: 0, value: {} }, viewers: new Map() };
        const emit = (channel: string, ...args: unknown[]) => {
          if (closed) return;
          // Empty output polls and identical callbacks are NOT new UI revisions.
          // Compare before cloning/stringifying a potentially large retained output.
          if (pending.states[channel] && samePresentation(pending.states[channel].args, args)) return;
          const copy = jsonCopy(args);
          const size = Buffer.byteLength(JSON.stringify(copy));
          const previous = sizes.get(channel) ?? 0;
          const projectSize = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
          const totalSize = [...stateSizes.values()].reduce((sum, values) => sum + [...values.values()].reduce((bytes, value) => bytes + value, 0), 0);
          if ((!sizes.has(channel) && sizes.size >= 256) || projectSize - previous + size > workspaceFrameBytes || totalSize - previous + size > 256 * 1024 * 1024) throw new BoundaryError('BUDGET_EXCEEDED');
          sizes.set(channel, size);
          pending.states[channel] = { version: ++pending.version, args: copy };
        };
        let runtime: ProjectWorkspaceRuntime;
        try { runtime = options.create({ id, directory, locale: request.locale, preferences: request.preferences, emit }); }
        catch (error) { stateSizes.delete(id); throw error; }
        workspace = Object.assign(pending, { runtime });
        projects.set(directory, workspace); byId.set(id, workspace);
      } else workspace.runtime.locale(request.locale);
      // Stale viewer records contain no runtime ownership and can be detached
      // explicitly. Bound simultaneous attachments; never evict project data.
      for (const project of projects.values()) for (const [token, viewer] of project.viewers) {
        sweep(viewer);
        if (viewer.seen + 60_000 <= now()) project.viewers.delete(token);
      }
      if (workspace.viewers.size >= 64) throw new BoundaryError('QUERY_LIMIT');
      const token = randomBytes(32).toString('hex');
      workspace.viewers.set(token, { token, sequence: 0, seen: now(), jobs: new Map() });
      return { kind: 'attached', generation: options.generation, workspace: workspace.id, viewer: token, version: workspace.version, uiRevision: workspace.ui.revision };
    }
    const { workspace, viewer } = lookup(request); sweep(viewer);
    if (request.op === 'detach') {
      workspace.viewers.delete(request.viewer);
      return { kind: 'detached' }; // No reset, release, close, cancel or business cleanup.
    }
    if (request.op === 'read') return read(workspace, viewer, request);
    if (request.op === 'ui') {
      if (request.revision !== workspace.ui.revision) throw new BoundaryError('CONFLICT');
      workspace.ui = { revision: workspace.ui.revision + 1, value: jsonCopy(request.value, workspacePayloadBytes) };
      return { kind: 'ui', revision: workspace.ui.revision };
    }
    if (request.op === 'ui-patch') {
      if (request.revision !== workspace.ui.revision) throw new BoundaryError('CONFLICT');
      const previous = JSON.stringify(workspace.ui.value);
      if (request.start > previous.length || request.start + request.remove > previous.length) throw new BoundaryError('INVALID_INPUT');
      const text = previous.slice(0, request.start) + request.insert + previous.slice(request.start + request.remove);
      if (Buffer.byteLength(text) > workspacePayloadBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      const value: unknown = JSON.parse(text);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new BoundaryError('CONTENT_INVALID');
      workspace.ui = { revision: workspace.ui.revision + 1, value: value as Record<string, unknown> };
      return { kind: 'ui', revision: workspace.ui.revision };
    }
    if (request.op === 'command') {
      if (request.sequence !== viewer.sequence + 1 || viewer.jobs.size >= 64) throw new BoundaryError('CONFLICT');
      const args = jsonCopy(request.args, workspacePayloadBytes);
      const argumentBytes = Buffer.byteLength(JSON.stringify(args));
      const jobs = [...projects.values()].reduce((sum, project) => sum + [...project.viewers.values()].reduce((count, current) => count + current.jobs.size, 0), 0);
      if (pendingCommands >= 64 || jobs >= 256 || pendingArgumentBytes + argumentBytes > transientLimit) throw new BoundaryError('QUERY_LIMIT');
      viewer.sequence = request.sequence;
      pendingCommands++; pendingArgumentBytes += argumentBytes;
      const job: Job = { id: identifier(now()), phase: 'pending' };
      viewer.jobs.set(job.id, job);
      // The HTTP request only admits the command. Long-running commands and
      // their results belong to the workspace, not this request's disconnect.
      void Promise.resolve().then(() => workspace.runtime.invoke(request.method, args)).then(result => {
        ++workspace.version; // Synchronous selector-only changes must reach viewers too.
        Object.assign(job, { phase: 'done', ...jsonCopy(result, 480_000) });
      }).catch(error => { job.phase = 'error'; job.error = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'; })
        .finally(() => { pendingCommands--; pendingArgumentBytes -= argumentBytes; });
      return { kind: 'accepted', id: job.id };
    }
    if (request.op === 'job') {
      const job = viewer.jobs.get(request.id);
      if (!job) throw new BoundaryError('NOT_FOUND');
      // Result delivery is explicit. Keep a bounded tombstone until detach;
      // polling must not re-run a dispatched command after a lost response.
      return { kind: 'job', ...jsonCopy(job) };
    }
    if (request.op === 'ack-job') {
      const job = viewer.jobs.get(request.id);
      if (!job || job.phase === 'pending') throw new BoundaryError('CONFLICT');
      viewer.jobs.delete(request.id);
      return { kind: 'acknowledged' };
    }
    if (request.op === 'upload-begin') {
      if (viewer.upload) throw new BoundaryError('CONFLICT');
      if (transientBytes() + request.bytes > transientLimit) throw new BoundaryError('QUERY_LIMIT');
      viewer.upload = { id: identifier(now()), bytes: request.bytes, parts: [], received: 0, expires: now() + 30_000 };
      return { kind: 'upload', id: viewer.upload.id, offset: 0 };
    }
    const upload = viewer.upload;
    if (!upload || upload.id !== request.id || upload.expires <= now()) throw new BoundaryError('VIEW_EXPIRED');
    if (request.op === 'upload-part') {
      const data = Buffer.from(request.data, 'base64');
      if (!data.length || data.toString('base64') !== request.data || data.length > workspaceChunkBytes || upload.received !== request.offset || upload.received + data.length > upload.bytes) throw new BoundaryError('INVALID_INPUT');
      upload.parts.push(data); upload.received += data.length;
      return { kind: 'upload', id: upload.id, offset: upload.received };
    }
    if (upload.received !== upload.bytes) throw new BoundaryError('CONTENT_INVALID');
    delete viewer.upload;
    const decoded = projectWorkspaceRequestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(upload.parts))));
    if ((decoded.op !== 'command' && decoded.op !== 'ui' && decoded.op !== 'ui-patch') || decoded.workspace !== workspace.id || decoded.viewer !== viewer.token) throw new BoundaryError('INVALID_INPUT');
    return handle(decoded);
  }
  return {
    handle,
    get size() { return projects.size; },
    close() {
      if (closed) return; closed = true;
      for (const workspace of projects.values()) workspace.runtime.close();
      projects.clear(); byId.clear(); stateSizes.clear();
    },
  };
}
