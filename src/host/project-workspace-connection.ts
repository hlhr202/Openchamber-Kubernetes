import { BoundaryError } from '../shared/errors.ts';
import { workspaceChunkBytes, workspaceFrameBytes, workspacePayloadBytes } from '../shared/project-workspace-protocol.ts';
import type { WorkspaceReference, WorkspaceFrame, WorkspaceEffect } from '../shared/project-workspace-protocol.ts';

type Transport = (request: { method: 'POST'; path: string; body: string }) => Promise<{ status: number; body: string }>;
const bytes = (text: string) => new TextEncoder().encode(text);
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
type Result = Record<string, unknown>;
export class ProjectWorkspaceConnection {
  #reference: WorkspaceReference | undefined;
  #version = 0; #sequence = 0; #uiRevision = 0; #ui = '{}'; #closed = false;
  #admission: Promise<unknown> = Promise.resolve();
  #reads: Promise<void> = Promise.resolve();
  #uploads: Promise<unknown> = Promise.resolve();
  readonly request: Transport;
  readonly frame: (frame: WorkspaceFrame, initial: boolean) => void;
  readonly effects: (effects: WorkspaceEffect[]) => Promise<void>;
  constructor(request: Transport, frame: (frame: WorkspaceFrame, initial: boolean) => void, effects: (effects: WorkspaceEffect[]) => Promise<void>) {
    this.request = request; this.frame = frame; this.effects = effects;
  }
  async #post(value: unknown): Promise<Result> {
    const body = JSON.stringify(value);
    if (bytes(body).length > 64_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const response = await this.request({ method: 'POST', path: '/v2/workspaces', body });
    if (bytes(response.body).length > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const valueOut = JSON.parse(response.body) as Result;
    if (response.status !== 200) throw new BoundaryError('STATE_UNAVAILABLE');
    return valueOut;
  }
  async #send(value: unknown): Promise<Result> {
    const next = this.#uploads.then(() => this.#sendPayload(value));
    this.#uploads = next.catch(() => {});
    return next;
  }
  async #sendPayload(value: unknown): Promise<Result> {
    const data = bytes(JSON.stringify(value));
    if (data.length > workspacePayloadBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    if (data.length <= 48_000) return this.#post(value);
    const ref = this.#reference; if (!ref) throw new BoundaryError('VIEW_EXPIRED');
    const upload = await this.#post({ op: 'upload-begin', ...ref, bytes: data.length });
    for (let offset = 0; offset < data.length; offset += workspaceChunkBytes) {
      const end = Math.min(data.length, offset + workspaceChunkBytes);
      const part = await this.#post({ op: 'upload-part', ...ref, id: upload.id, offset, data: encode(data.subarray(offset, end)) });
      if (part.offset !== end) throw new BoundaryError('STATE_UNAVAILABLE');
    }
    return this.#post({ op: 'upload-finish', ...ref, id: upload.id });
  }
  async attach(directory: string, locale: string, preferences?: unknown): Promise<void> {
    const result = await this.#post({ op: 'attach', directory, locale, preferences });
    if (typeof result.workspace !== 'string' || typeof result.viewer !== 'string' || typeof result.uiRevision !== 'number') throw new BoundaryError('STATE_UNAVAILABLE');
    this.#reference = { workspace: result.workspace, viewer: result.viewer }; this.#uiRevision = result.uiRevision;
    if (this.#closed) { await this.#post({ op: 'detach', ...this.#reference }); return; }
    await this.read(true);
  }
  read(initial = false): Promise<void> {
    const next = this.#reads.then(() => this.#read(initial));
    this.#reads = next.catch(() => {});
    return next;
  }
  async #read(initial: boolean): Promise<void> {
    const ref = this.#reference; if (!ref || this.#closed) return;
    let result = await this.#post({ op: 'read', ...ref, after: this.#version, initial });
    if (result.kind === 'unchanged') return;
    const parts: Uint8Array[] = [], id = result.id, version = result.version, total = result.bytes;
    if (typeof total !== 'number' || total < 0 || total > workspaceFrameBytes) throw new BoundaryError('STATE_UNAVAILABLE');
    let offset = 0;
    for (;;) {
      if (result.id !== id || result.version !== version || result.offset !== offset || typeof result.data !== 'string') throw new BoundaryError('STATE_UNAVAILABLE');
      const part = decode(result.data); offset += part.length; parts.push(part);
      if (offset !== result.end || offset > total || part.length > workspaceChunkBytes) throw new BoundaryError('STATE_UNAVAILABLE');
      if (result.complete) break;
      if (!part.length) throw new BoundaryError('STATE_UNAVAILABLE');
      result = await this.#post({ op: 'read', ...ref, after: this.#version, initial, cursor: id, offset });
    }
    if (offset !== total || this.#closed) return;
    const data = new Uint8Array(total); let at = 0;
    for (const part of parts) { data.set(part, at); at += part.length; }
    const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as WorkspaceFrame;
    if (typeof frame.version !== 'number' || frame.version < this.#version || !frame.states || !frame.selectors) throw new BoundaryError('STATE_UNAVAILABLE');
    this.#version = frame.version;
    if (frame.ui) { this.#uiRevision = frame.ui.revision; this.#ui = JSON.stringify(frame.ui.value); }
    this.frame(frame, initial);
  }
  command(method: string, args: unknown[]): Promise<unknown> {
    const ref = this.#reference;
    if (!ref || this.#closed) return Promise.reject(new BoundaryError('VIEW_EXPIRED'));
    const sequence = ++this.#sequence;
    // Admissions are ordered; completion is independent so Cancel can reach a
    // running read. A failed/unknown admission is NEVER automatically replayed.
    const admission = this.#admission.then(() => this.#send({ op: 'command', ...ref, sequence, method, args }));
    this.#admission = admission;
    return admission.then(async accepted => {
      if (typeof accepted.id !== 'string') throw new BoundaryError('STATE_UNAVAILABLE');
      for (;;) {
        const job = await this.#post({ op: 'job', ...ref, id: accepted.id });
        if (job.phase === 'pending') {
          if (this.#closed) throw new BoundaryError('VIEW_EXPIRED');
          await new Promise<void>(resolve => setTimeout(resolve, 100)); continue;
        }
        if (job.phase !== 'done') {
          if (job.phase === 'error') await this.#post({ op: 'ack-job', ...ref, id: accepted.id });
          throw new BoundaryError('STATE_UNAVAILABLE');
        }
        if (this.#closed) return undefined; // Never deliver effects to a detached viewer.
        if (job.effects) await this.effects(job.effects as WorkspaceEffect[]);
        if (!this.#closed) await this.read();
        await this.#post({ op: 'ack-job', ...ref, id: accepted.id });
        return job.value;
      }
    });
  }
  async saveUi(value: Record<string, unknown>): Promise<void> {
    const ref = this.#reference; if (!ref || this.#closed) return;
    const next = JSON.stringify(value); if (next === this.#ui) return;
    let start = 0, suffix = 0;
    while (start < this.#ui.length && start < next.length && this.#ui[start] === next[start]) start++;
    while (suffix < this.#ui.length - start && suffix < next.length - start && this.#ui[this.#ui.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    const result = await this.#send({ op: 'ui-patch', ...ref, revision: this.#uiRevision, start, remove: this.#ui.length - start - suffix, insert: next.slice(start, next.length - suffix) });
    if (typeof result.revision !== 'number') throw new BoundaryError('STATE_UNAVAILABLE');
    this.#uiRevision = result.revision; this.#ui = next;
  }
  dispose(): void {
    this.#closed = true;
    const ref = this.#reference;
    if (ref) void Promise.allSettled([this.#admission, this.#uploads]).then(() => this.#post({ op: 'detach', ...ref })).catch(() => {});
    // Only the viewer is detached. Never dispatch runtime dispose/stop/close.
  }
}
