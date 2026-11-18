import { BoundaryError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { boundedName, containsControlCharacters, readTarget, sameTarget, stableNodeId } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import { configPageSchema } from '../shared/protocol.ts';
import { readConfigSelection } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { localTreeEntries } from '../shared/tree-entries.ts';
import type { TreeEntry } from '../shared/tree-entries.ts';
import { TreeModel } from '../shared/tree-model.ts';
import type { TreeRow } from '../shared/tree-model.ts';
import { createTreeSource } from './tree-source.ts';
import type { TreeTransport } from './tree-source.ts';
import { treeQueryAffectedByWatch } from '../shared/tree-watch.ts';
import { treeQueryAffectedByCreate } from '../shared/tree-create-effect.ts';
import { applyOutcomeSchema } from '../shared/manifest-apply-protocol.ts';
import { createOutcomeSchema } from '../shared/manifest-create-protocol.ts';
import { deleteOutcomeSchema } from '../shared/delete-protocol.ts';
import { watchPageSchema } from '../shared/watch-protocol.ts';
import { TreeRefreshQueue } from './tree-refresh-queue.ts';
import type { TreeRefreshResult, TreeRefreshSchedule } from './tree-refresh-queue.ts';

type RootState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly total: number; readonly nextOffset: number | null;
  readonly error: ErrorCode | null; readonly available: boolean };
export type TreeSnapshot = { readonly roots: RootState; readonly rows: readonly TreeRow[]; readonly generation: number; readonly message: string | null };
const idle: RootState = Object.freeze({ phase: 'idle', total: 0, nextOffset: null, error: null, available: false });

export type TreeControllerOptions = {
  readonly helmTree?: boolean;
  readonly minAutoRefreshIntervalMs?: number;
  readonly now?: () => number;
  readonly scheduleDelay?: (callback: () => void, delayMs: number) => () => void;
};

// Headless controller: UI geometry, DOM keyboard events, preference storage and business actions are NOT implemented here.
export class TreeController {
  readonly #model = new TreeModel();
  #source: ReturnType<typeof createTreeSource>;
  readonly #show: (snapshot: TreeSnapshot) => void;
  readonly #pending = new Map<string, AbortController>();
  readonly #inflight = new Set<AbortController>();
  readonly #automatic = new Map<string, AbortController>();
  readonly #manualInflight = new Map<string, Promise<TreeRefreshResult>>();
  readonly #trailingRefresh = new Set<string>();
  readonly #refreshes: TreeRefreshQueue;
  #helmTree: boolean;
  #watch: string | undefined;
  #selection: ConfigSelection = { mode: 'default' };
  #identity: string | undefined;
  #rootConfiguration: string | undefined;
  #active = false;
  #roots: RootState = idle;
  #message: string | null = null;
  #disposed = false;
  #typed = '';
  #typedAt = 0;
  #transport: TreeTransport;
  constructor(request: TreeTransport, show: (snapshot: TreeSnapshot) => void = () => {}, scheduling?: TreeRefreshSchedule, options: TreeControllerOptions = {}) {
    this.#transport = request;
    this.#helmTree = options.helmTree ?? false;
    this.#source = createTreeSource(request, { helmTree: this.#helmTree }); this.#show = show;
    this.#refreshes = new TreeRefreshQueue(id => this.#load(id, false, true), id => {
      if (!this.#model.visible().some(row => row.id === id && row.expanded && row.stale)) return;
      const ticket = this.#model.begin(id); if (ticket) this.#model.fail(ticket, 'QUERY_LIMIT'); this.#paint();
    }, scheduling, {
      ...(options.minAutoRefreshIntervalMs !== undefined ? { minIntervalMs: options.minAutoRefreshIntervalMs } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.scheduleDelay ? { scheduleDelay: options.scheduleDelay } : {}),
      canRun: id => !this.#hasPendingAncestor(id),
    });
  }
  #hasPendingAncestor(id: string): boolean {
    const byId = new Map(this.#model.visible().map(row => [row.id, row]));
    let current = byId.get(id)?.parent ?? null;
    while (current) {
      const parent = byId.get(current);
      if (!parent) break;
      const isLocal = parent.entry.query !== null && !!localTreeEntries(parent.entry.query, { helmReleases: this.#helmTree });
      if (parent.phase === 'loading' || (!isLocal && parent.stale) || this.#pending.has(parent.id) || this.#refreshes.hasActive(parent.id)) return true;
      current = parent.parent;
    }
    return false;
  }
  enableHelmTree(enabled = true): void {
    this.#helmTree = enabled;
    this.#source = createTreeSource(this.#transport, { helmTree: enabled });
  }
  get snapshot(): TreeSnapshot {
    const stale = this.#roots.phase !== 'ready';
    return Object.freeze({ roots: this.#roots, generation: this.#model.generation, message: this.#message,
      rows: Object.freeze(this.#model.visible().map(row => stale ? Object.freeze({ ...row, stale: true, canMore: false, empty: false }) : row)) });
  }
  loadedProof(id: string) { return this.#active && this.#roots.phase === 'ready' ? this.#model.loadedProof(id) : undefined; }
  #paint() { if (!this.#disposed) this.#show(this.snapshot); }
  #stop(ids: readonly string[]) { for (const id of ids) { this.#trailingRefresh.delete(id); this.#pending.get(id)?.abort(); this.#pending.delete(id); } }
  configure(input: unknown, selectionInput: unknown, projectId: string, offset = 0): void {
    if (this.#disposed) return;
    try {
      const parsed = configPageSchema.safeParse(input);
      if (!parsed.success || !boundedName.safeParse(projectId).success || !Number.isSafeInteger(offset) || offset < 0) throw new BoundaryError('STATE_UNAVAILABLE');
      const config = parsed.data, selection = readConfigSelection(selectionInput), end = offset + config.contexts.length;
      if (config.sources.mode !== selection.mode || end > config.total || config.nextOffset !== (end < config.total ? end : null)
        || (end < config.total && config.contexts.length !== 100)) throw new BoundaryError('STATE_UNAVAILABLE');
      const identity = JSON.stringify([config.serviceGeneration, projectId, config.configIdentity, selection]);
      const rootConfiguration = offset === 0 ? JSON.stringify([identity, config]) : undefined;
      // A repeated identical first page is not a request to discard expanded
      // branches, pagination, selection, focus or active watches.
      if (rootConfiguration && rootConfiguration === this.#rootConfiguration && this.#roots.phase === 'ready') return;
      if (offset && (identity !== this.#identity || offset !== this.#roots.nextOffset || config.total !== this.#roots.total)) throw new BoundaryError('STALE_TARGET');
      const active = config.contexts.filter(context => context.active);
      if (active.length > 1 || (offset > 0 && this.#active && active.length)) throw new BoundaryError('STATE_UNAVAILABLE');
      const entries: TreeEntry[] = config.contexts.map(context => {
        const target = readTarget({ serviceGeneration: config.serviceGeneration, projectId, configIdentity: config.configIdentity, context: context.name, namespace: context.namespace });
        const expandable = context.active && context.available && !config.currentContextMissing;
        const icon = context.name === 'minikube' ? 'minikube' : 'kubernetes';
        return { node: { type: 'context', id: stableNodeId(target, 'context', context.name), label: context.name, expandable, icon,
          tooltip: `${context.name}\nCluster: ${context.clusterName}` }, query: expandable ? { kind: 'context', target } : null };
      });
      if (!offset) { this.#rootConfiguration = rootConfiguration; this.stopWatchUpdates(); this.#stop([...this.#pending.keys()]); this.#model.reset(entries, config.total); this.#active = active.length > 0; this.#typed = ''; }
      else { this.#model.appendRoots(entries); this.#active ||= active.length > 0; }
      this.#selection = selection; this.#identity = identity;
      this.#roots = Object.freeze({ phase: 'ready', total: config.total, nextOffset: config.nextOffset, error: null, available: config.status === 'ready' && !config.currentContextMissing });
    } catch (error) {
      this.stopWatchUpdates();
      this.#stop([...this.#pending.keys()]);
      this.#roots = Object.freeze({ ...this.#roots, phase: 'error', error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    }
    this.#paint();
  }
  suspend(error?: ErrorCode): void {
    if (this.#disposed) return;
    this.stopWatchUpdates();
    this.#stop([...this.#pending.keys()]);
    for (const row of this.#model.visible()) if (row.parent === null) this.#model.cancel(row.id);
    this.#roots = Object.freeze({ ...this.#roots, phase: error ? 'error' : 'loading', error: error ?? null }); this.#paint();
  }
  clear(): void { this.stopWatchUpdates(); this.#stop([...this.#pending.keys()]); this.#model.clear(); this.#roots = idle; this.#identity = undefined; this.#rootConfiguration = undefined; this.#active = false; this.#typed = ''; this.#paint(); }
  async #load(id: string, append = false, automatic = false, expandOnSettle = false): Promise<TreeRefreshResult> {
    const before = this.#model.visible().find(row => row.id === id);
    if (this.#disposed || this.#roots.phase !== 'ready' || !before || automatic && !before.expanded) return { phase: 'obsolete' };
    const descendants = this.#model.descendants(id);
    this.#stop([id, ...descendants]); this.#model.cancel(id);
    const ticket = this.#model.begin(id, append, expandOnSettle);
    if (!ticket) return { phase: 'obsolete' };
    const local = localTreeEntries(ticket.query, { helmReleases: this.#helmTree });
    if (local || ticket.query.kind === 'helm-dependency') {
      try {
        if (local) this.#model.apply(ticket, { entries: local, cursor: null, proof: { resourceVersion: null } });
        else this.#model.fail(ticket, 'STATE_UNAVAILABLE');
      } catch (error) { this.#model.fail(ticket, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
      this.#paint();
      return {
        phase: 'ready',
        children: local ? this.#model.visible().filter(row => row.parent === id && row.expanded && (row.stale || row.phase === 'idle')).map(row => row.id) : [],
      }; // Local descriptors never consume an SDK/HTTP admission slot.
    }
    const controller = new AbortController();
    if (this.#inflight.size >= 8) { this.#model.fail(ticket, 'QUERY_LIMIT'); this.#paint(); return { phase: 'error' }; }
    this.#pending.set(id, controller); this.#inflight.add(controller); if (automatic) this.#automatic.set(id, controller); this.#paint();
    let result: TreeRefreshResult = { phase: 'obsolete' };
    try {
      const page = await this.#source(ticket.query, this.#selection, controller.signal, ticket.cursor, ticket.previous, automatic ? 'background' : 'manual');
      if (!controller.signal.aborted && this.#model.current(ticket)) {
        this.#model.apply(ticket, page);
        // A refresh can remove/rebind descendants; their old queries must never resurrect them.
        result = { phase: 'ready', children: this.#model.visible().filter(row => row.parent === id && row.expanded && (row.stale || row.phase === 'idle')).map(row => row.id) };
      }
    } catch (error) { if (this.#model.fail(ticket, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE')) result = { phase: 'error' }; }
    finally {
      this.#inflight.delete(controller); if (this.#pending.get(id) === controller) this.#pending.delete(id);
      if (this.#automatic.get(id) === controller) this.#automatic.delete(id); this.#paint();
    }
    return result;
  }
  async #runManual(id: string, append = false, expandOnSettle = false): Promise<TreeRefreshResult> {
    const existing = this.#manualInflight.get(id);
    if (existing) {
      if (!append) this.#trailingRefresh.add(id);
      return existing;
    }
    const run: Promise<TreeRefreshResult> = (async (): Promise<TreeRefreshResult> => {
      const result = await this.#load(id, append, false, expandOnSettle);
      if (result.phase === 'ready') this.#refreshes.add(result.children);
      return result;
    })().finally(() => {
      if (this.#manualInflight.get(id) === run) this.#manualInflight.delete(id);
      if (this.#trailingRefresh.delete(id) && !this.#disposed && this.#roots.phase === 'ready' && this.#model.visible().some(row => row.id === id)) {
        void this.#runManual(id, false);
      }
    });
    this.#manualInflight.set(id, run);
    return run;
  }
  async expand(id: string): Promise<void> {
    if (this.#disposed || this.#roots.phase !== 'ready' || !this.#model.visible().some(row => row.id === id)) return;
    const inflight = this.#manualInflight.get(id);
    const load = this.#model.expand(id, true);
    if (!inflight && load) await this.#runManual(id, false, true);
    else { this.#paint(); if (inflight) await inflight; }
  }
  // Read only. A namespace change rebuilds every binding. Reopen navigation and
  // previously open resource folders one at a time; never recycle old objects,
  // list cursors, expanded object branches or watches into the new namespace.
  async reopenNamespaceFolders(previous: TreeSnapshot, target: TargetIdentity): Promise<void> {
    const generation = this.#model.generation;
    const active = () => this.#roots.phase === 'ready' && !this.#disposed && this.#model.generation === generation;
    const find = (kind: 'context' | 'group' | 'resources', name?: string) => active() ? this.#model.visible().find(row => {
      const query = row.entry.query;
      return query?.kind === kind && sameTarget(query.target, target)
        && (query.kind === 'context' || (query.kind === 'group' ? query.label : query.resource) === name);
    }) : undefined;
    const root = find('context');
    if (!root) return;
    await this.expand(root.id);
    const wasOpen = (row: TreeRow) => row.expanded || row.opening;
    for (const row of previous.rows) {
      const query = row.entry.query;
      if (query?.kind !== 'group' || !wasOpen(row) || query.target.context !== target.context) continue;
      const next = find('group', query.label);
      if (next?.phase === 'idle') await this.expand(next.id);
    }
    for (const row of previous.rows) {
      const query = row.entry.query;
      if (query?.kind !== 'resources' || !wasOpen(row) || query.target.context !== target.context) continue;
      const next = find('resources', query.resource);
      if (next?.phase === 'idle') await this.expand(next.id);
    }
  }
  async refresh(id: string): Promise<void> {
    if (this.#disposed || this.#roots.phase !== 'ready') return;
    if (this.#model.visible().some(row => row.id === id)) this.#refreshes.retry(this.#model.descendants(id, true));
    const existing = this.#manualInflight.get(id);
    if (existing) {
      this.#trailingRefresh.add(id);
      await existing;
      const followUp = this.#manualInflight.get(id);
      if (followUp) await followUp;
      return;
    }
    await this.#runManual(id, false);
  }
  // Upstream toolbar Refresh: invalidate the whole tree, then re-read VISIBLE EXPANDED branches only.
  // Never a Describe Refresh, Helm repo update, config switch, write, auth refresh, watch lifecycle or cross-context scan.
  refreshAll(): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return;
    this.#stop([...this.#pending.keys()]);
    const invalidated = this.#model.invalidateQueries(() => true);
    this.#refreshes.retry(invalidated);
    const expanded = this.#model.visible().filter(row => row.expanded);
    const expandedIds = new Set(expanded.map(row => row.id));
    // Enqueue top-most visible expanded branches first; each parent queues its expanded children upon completion (parent-before-child).
    const topMost = expanded.filter(row => !row.parent || !expandedIds.has(row.parent)).map(row => row.id);
    this.#refreshes.add(topMost, { automatic: false });
    this.#paint();
  }
  async more(id: string): Promise<void> { await this.#runManual(id, true); }
  collapse(id: string): void { if (this.#disposed || !this.#model.visible().some(row => row.id === id)) return; const ids = this.#model.descendants(id, true); for (const item of ids) this.#manualInflight.delete(item); this.#refreshes.remove(ids); this.#stop(ids); this.#model.collapse(id); this.#paint(); }
  collapseAll(): void { if (this.#disposed) return; this.#manualInflight.clear(); this.#refreshes.remove(this.#model.visible().flatMap(row => row.parent === null ? this.#model.descendants(row.id, true) : [])); this.#stop([...this.#pending.keys()]); this.#model.collapseAll(); this.#paint(); }
  cancel(id: string): void { if (this.#disposed || !this.#model.visible().some(row => row.id === id)) return; const ids = this.#model.descendants(id, true); for (const item of ids) this.#manualInflight.delete(item); this.#refreshes.remove(ids); this.#stop(ids); this.#model.cancel(id); this.#paint(); }
  observeWatch(input: unknown): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return;
    const parsed = watchPageSchema.safeParse(input); if (!parsed.success) return; const page = parsed.data;
    if (page.handle.generation !== page.source.target.serviceGeneration || JSON.stringify(page.source.selection) !== JSON.stringify(this.#selection)
      || !page.lost && !page.events.some(event => event.type !== 'BOOKMARK')) return;
    const ids = this.#model.invalidateQueries(query => treeQueryAffectedByWatch(query, page.source));
    if (!ids.length) return;
    const identity = JSON.stringify([page.handle.generation, page.handle.task, page.handle.consumer, page.handle.epoch]);
    if (identity !== this.#watch) { this.#refreshes.reset(); this.#watch = identity; }
    for (const id of ids) this.#stop(this.#model.descendants(id, true));
    const invalidatedSet = new Set(ids);
    const topMost = this.#model.visible()
      .filter(row => invalidatedSet.has(row.id) && row.expanded && (!row.parent || !invalidatedSet.has(row.parent)))
      .map(row => row.id);
    this.#refreshes.add(topMost, { automatic: true });
    this.#paint();
  }
  observeCreate(input: unknown): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return; const parsed = createOutcomeSchema.safeParse(input); if (!parsed.success) return; const value = parsed.data;
    const ids = this.#model.invalidateQueries(query => value.steps.some(step => step.phase === 'succeeded' && step.reference && treeQueryAffectedByCreate(query, value.target, step.reference)));
    for (const id of ids) this.#stop(this.#model.descendants(id, true));
    if (ids.length) this.#paint(); // Mark stale only; no implicit fresh GET, editor replacement or write-reference update.
  }
  observeApply(input: unknown): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return; const parsed = applyOutcomeSchema.safeParse(input); if (!parsed.success || parsed.data.phase !== 'succeeded' || parsed.data.unchanged) return;
    const value = parsed.data, ids = this.#model.invalidateQueries(query => treeQueryAffectedByCreate(query, value.target, value.reference));
    for (const id of ids) this.#stop(this.#model.descendants(id, true)); if (ids.length) this.#paint();
  }
  // Approved batch-2 upgrade: a determinate succeeded Delete (including a CRD definition body)
  // invalidates the same queries a Create would affect — the Custom Resources branch for
  // definition deletes, the owning list for instance deletes. Mark stale only; no auto GET.
  observeDelete(input: unknown): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return; const parsed = deleteOutcomeSchema.safeParse(input); if (!parsed.success || parsed.data.phase !== 'accepted') return;
    const value = parsed.data;
    const ids = this.#model.invalidateQueries(query => treeQueryAffectedByCreate(query, value.target, value.parameters.reference));
    for (const id of ids) this.#stop(this.#model.descendants(id, true));
    if (ids.length) this.#paint();
  }
  // Upstream showInfoMessage: activating a message node shows ONLY its bounded text.
  // No Helm/refresh/install/write menu, no notification/chat/clipboard, no HTML — the label is
  // already schema-bounded (no control characters), and the message clears on any other selection.
  activate(id: string): void {
    if (this.#disposed || this.#roots.phase !== 'ready') return;
    const row = this.#model.visible().find(row => row.id === id && row.entry.node.type === 'message');
    if (!row) { this.#message = null; this.#paint(); return; }
    this.#model.focus(id); this.#message = row.entry.node.label; this.#paint();
  }
  stopWatchUpdates(): void {
    this.#watch = undefined; this.#refreshes.reset();
    for (const [id, controller] of this.#automatic) {
      controller.abort();
      if (this.#pending.get(id) === controller) { this.#model.cancel(id); this.#pending.delete(id); }
    }
    this.#paint();
  }
  select(id: string): void { if (!this.#disposed && this.#model.visible().some(row => row.id === id)) { this.#model.select(id); if (this.#model.visible().find(row => row.id === id && row.selected)?.entry.node.type !== 'message') this.#message = null; this.#paint(); } }
  focus(id: string): void { if (!this.#disposed) { this.#model.focus(id); this.#paint(); } }
  async keyboard(key: string): Promise<void> {
    if (this.#disposed || this.#roots.phase !== 'ready') return;
    const action = this.#model.keyboard(key);
    if (action?.kind === 'expand') await this.expand(action.id);
    else if (action?.kind === 'collapse') this.collapse(action.id);
    this.#paint();
  }
  typeahead(text: string, now: number): void {
    if (this.#disposed || this.#roots.phase !== 'ready' || !Number.isFinite(now) || now < 0 || [...text].length !== 1 || /\s/u.test(text) || containsControlCharacters(text)) return;
    this.#typed = now >= this.#typedAt && now - this.#typedAt < 700 ? `${this.#typed}${text}`.slice(-64) : text; this.#typedAt = now;
    const rows = this.#model.visible(), start = rows.findIndex(row => row.focused), ordered = [...rows.slice(start + 1), ...rows.slice(0, start + 1)];
    const match = ordered.find(row => row.entry.node.label.toLocaleLowerCase('en').startsWith(this.#typed.toLocaleLowerCase('en')));
    if (match) this.#model.focus(match.id); this.#paint();
  }
  dispose(): void { this.#disposed = true; this.#refreshes.dispose(); this.clear(); }
}
