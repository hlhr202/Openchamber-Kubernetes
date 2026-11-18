// Portable pure session registry state machine for M5 (Terminal/Exec/PortForward/Dashboard) and
// the M7 debug bridge: target pinning, owner capability, detach/reattach, lease expiry and
// bounded per-session buffers. No IO, no timers — the service wrapper owns time and sockets.
import { BoundaryError } from './errors.ts';
export const sessionKinds = ['terminal', 'exec', 'port-forward', 'dashboard'] as const;
export type SessionKind = typeof sessionKinds[number];
export type SessionTarget = { readonly podUid: string; readonly podName: string; readonly namespace: string; readonly container?: string;
  readonly original?: { readonly resource: 'services' | 'deployments'; readonly name: string; readonly namespace: string; readonly uid: string; readonly resourceVersion: string } };
export type SessionState = { readonly id: string; readonly kind: SessionKind; readonly target: SessionTarget; readonly owner: string;
  readonly createdAt: number; readonly leaseExpiresAt: number; readonly detached: boolean; readonly closed: boolean; readonly closeReason?: string };
export const sessionLimits = Object.freeze({
  maxSessions: 16, maxPerKind: 8, leaseMs: 900_000, // 15 minutes, renewed by poll/io
  maxRecords: 80, // 16 live + bounded ended metadata; never evict a live capability.
  outputBufferBytes: 262_144, outputChunk: 32_768, historyEntries: 64,
});
function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  return a.podUid === b.podUid && a.podName === b.podName && a.namespace === b.namespace && a.container === b.container
    && JSON.stringify(a.original) === JSON.stringify(b.original);
}
export type SessionEvent = { readonly id: string; readonly kind: SessionKind; readonly reason: string; readonly at: number };
// The registry stores ONLY metadata and bounded opaque byte buffers; credentials, commands and
// payloads stay in the owning service adapter and never enter this pure state. Capability values
// are pre-digested by the service caller (never stored raw here).
export class SessionRegistry {
  readonly #sessions = new Map<string, SessionState>();
  readonly #capabilities = new Map<string, string>(); // sessionId -> capability digest
  readonly #closedCapabilities = new Map<string, string>(); // metadata-only original close result
  readonly #attachments = new Map<string, unknown>();
  readonly #expiredResources = new Set<string>();
  readonly #history: SessionEvent[] = [];
  #closed = false;
  open(input: { id: string; kind: SessionKind; target: SessionTarget; owner: string; capabilityDigest: string; now: number; attachment?: unknown }): SessionState {
    if (this.#closed) throw new BoundaryError('SERVICE_CLOSED');
    if (this.#sessions.has(input.id)) throw new BoundaryError('CONFLICT');
    const existing = [...this.#sessions.values()].filter(session => !session.closed);
    if (existing.length >= sessionLimits.maxSessions
      || existing.filter(session => session.kind === input.kind).length >= sessionLimits.maxPerKind) throw new BoundaryError('QUERY_LIMIT');
    if (existing.some(session => session.kind === input.kind && sameTarget(session.target, input.target) && !session.detached)) throw new BoundaryError('CONFLICT');
    if (this.#sessions.size >= sessionLimits.maxRecords) {
      const retired = [...this.#sessions.values()].find(session => session.closed && !this.#capabilities.has(session.id));
      if (!retired) throw new BoundaryError('QUERY_LIMIT');
      this.#sessions.delete(retired.id); this.#closedCapabilities.delete(retired.id);
    }
    const state: SessionState = { id: input.id, kind: input.kind, target: Object.freeze({ ...input.target,
      ...(input.target.original ? { original: Object.freeze({ ...input.target.original }) } : {}) }), owner: input.owner,
      createdAt: input.now, leaseExpiresAt: input.now + sessionLimits.leaseMs, detached: false, closed: false };
    this.#sessions.set(input.id, state);
    this.#capabilities.set(input.id, input.capabilityDigest);
    if (input.attachment !== undefined) this.#attachments.set(input.id, input.attachment);
    this.#record(input.id, input.kind, 'opened', input.now);
    return state;
  }
  authorize(id: string, capability: string, now: number, allowEnded = false, renew = true): SessionState {
    const session = this.#sessions.get(id);
    if (!session || (this.#capabilities.get(id) !== capability && !(allowEnded && session.closed && this.#closedCapabilities.get(id) === capability))) throw new BoundaryError('FORBIDDEN');
    if (session.closed && !allowEnded) throw new BoundaryError('SERVICE_CLOSED');
    if (session.leaseExpiresAt <= now) { this.#expire(id, now); throw new BoundaryError('VIEW_EXPIRED'); }
    if (session.closed || !renew) return session; // Tail/background output never renews a lease.
    this.#sessions.set(id, { ...session, leaseExpiresAt: now + sessionLimits.leaseMs });
    return this.#sessions.get(id)!;
  }
  detach(id: string, capabilityDigest: string, now: number): SessionState {
    const session = this.authorize(id, capabilityDigest, now);
    this.#sessions.set(id, { ...session, detached: true });
    this.#record(id, session.kind, 'detached', now);
    return this.#sessions.get(id)!;
  }
  // Reattach binds the SAME pinned target; a changed target is never silently adopted.
  reattach(id: string, capabilityDigest: string, target: SessionTarget, now: number): SessionState {
    const session = this.authorize(id, capabilityDigest, now);
    if (!sameTarget(session.target, target)) throw new BoundaryError('STALE_TARGET');
    this.#sessions.set(id, { ...session, detached: false });
    this.#record(id, session.kind, 'reattached', now);
    return this.#sessions.get(id)!;
  }
  close(id: string, capabilityDigest: string, reason: string, now: number): SessionState {
    const session = this.authorize(id, capabilityDigest, now, true);
    if (session.closed && this.#closedCapabilities.has(id)) return session;
    this.#sessions.set(id, { ...session, closed: true, closeReason: reason.slice(0, 128) });
    this.#capabilities.delete(id); this.#closedCapabilities.set(id, capabilityDigest);
    this.#attachments.delete(id);
    this.#record(id, session.kind, `closed:${reason.slice(0, 64)}`, now);
    return this.#sessions.get(id)!;
  }
  sweep(now: number): readonly string[] {
    for (const [id, session] of this.#sessions) if (this.#capabilities.has(id) && session.leaseExpiresAt <= now) this.#expire(id, now);
    const expired = [...this.#expiredResources]; this.#expiredResources.clear();
    return expired;
  }
  #expire(id: string, now: number): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.set(id, { ...session, closed: true, closeReason: 'lease-expired' });
    this.#capabilities.delete(id);
    this.#closedCapabilities.delete(id);
    this.#attachments.delete(id);
    this.#expiredResources.add(id);
    this.#record(id, session.kind, 'lease-expired', now);
  }
  observeEnded(id: string, reason: string, now: number): void {
    const session = this.#sessions.get(id);
    if (!session || session.closed) return;
    this.#sessions.set(id, { ...session, closed: true, closeReason: reason.slice(0, 128) });
    this.#record(id, session.kind, reason.slice(0, 128), now);
    // Keep the capability for bounded tail-output reads and explicit cleanup.
    // It cannot authorize input/reattach, and expires without renewal.
  }
  #record(id: string, kind: SessionKind, reason: string, at: number): void {
    this.#history.push({ id, kind, reason, at });
    if (this.#history.length > sessionLimits.historyEntries) this.#history.splice(0, this.#history.length - sessionLimits.historyEntries);
  }
  attachment(id: string): unknown { return this.#attachments.get(id); }
  list(): readonly SessionState[] { return Object.freeze([...this.#sessions.values()]); }
  events(): readonly SessionEvent[] { return Object.freeze([...this.#history]); }
  closeAll(now: number, reason: string): void {
    for (const [id, session] of this.#sessions) if (!session.closed) { this.#sessions.set(id, { ...session, closed: true, closeReason: reason.slice(0, 128) }); this.#capabilities.delete(id); this.#attachments.delete(id); this.#record(id, session.kind, `closed:${reason.slice(0, 64)}`, now); }
    this.#capabilities.clear(); this.#attachments.clear(); this.#expiredResources.clear(); this.#closedCapabilities.clear(); this.#closed = true;
  }
}
