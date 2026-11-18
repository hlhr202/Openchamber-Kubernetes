import { BoundaryError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { readTreeEntry, readTreeProof } from './tree-entries.ts';
import type { TreeEntry, TreePage, TreePageProof, TreeQuery } from './tree-entries.ts';
import { utf8ByteLength } from './identity.ts';
import { sameTreeQueryIdentity } from './tree-watch.ts';
import { mergeHelmReleaseEntries } from './helm-release-protocol.ts';

type BranchPhase = 'idle' | 'loading' | 'ready' | 'error';
type Row = { id: string; parent: string | null; entry: TreeEntry; children: string[]; expanded: boolean; opening?: true | undefined; phase: BranchPhase;
  stale: boolean; error: ErrorCode | null; cursor: string | null; proof: TreePageProof; revision: number };
export type TreeTicket = { readonly id: string; readonly generation: number; readonly revision: number; readonly query: TreeQuery;
  readonly cursor: string | undefined; readonly previous: TreePageProof; readonly append: boolean };
export type TreeRow = { readonly id: string; readonly parent: string | null; readonly entry: TreeEntry; readonly level: number;
  readonly position: number; readonly setSize: number; readonly expanded: boolean; readonly opening?: true; readonly phase: BranchPhase;
  readonly stale: boolean; readonly error: ErrorCode | null; readonly canMore: boolean; readonly empty: boolean; readonly selected: boolean; readonly focused: boolean };

// Pure in-memory view state. Handles identify occurrences, NOT host owners or API resources.
// The same Pod under Nodes and Workloads must have independent expansion/focus state.
export class TreeModel {
  #rows = new Map<string, Row>();
  #roots: string[] = [];
  #generation = 0;
  #serial = 0;
  #rootTotal = 0;
  #selected: string | null = null;
  #focused: string | null = null;
  readonly #maximumNodes: number;
  readonly #maximumBytes: number;
  constructor(limits = { nodes: 5000, bytes: 8_000_000 }) {
    if (!Number.isInteger(limits.nodes) || limits.nodes < 1 || limits.nodes > 5000 || !Number.isInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 8_000_000) throw new BoundaryError('INVALID_INPUT');
    this.#maximumNodes = limits.nodes; this.#maximumBytes = limits.bytes;
  }
  #row(id: string): Row {
    const row = this.#rows.get(id);
    if (!row) throw new BoundaryError('STALE_TARGET');
    return row;
  }
  #budget(rows: Map<string, Row>) {
    if (rows.size > this.#maximumNodes || utf8ByteLength(JSON.stringify([...rows.values()])) > this.#maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  }
  #newRow(entry: TreeEntry, parent: string | null): Row {
    return { id: `tree-${this.#generation}-${++this.#serial}`, parent, entry, children: [], expanded: false, phase: 'idle', stale: false,
      error: null, cursor: null, proof: { resourceVersion: null }, revision: 0 };
  }
  reset(entries: readonly TreeEntry[], total = entries.length): void {
    if (!Number.isInteger(total) || total < entries.length || total > 5000) throw new BoundaryError('INVALID_INPUT');
    const parsed = entries.map(readTreeEntry);
    if (new Set(parsed.map(item => item.node.id)).size !== parsed.length) throw new BoundaryError('STATE_UNAVAILABLE');
    ++this.#generation;
    const rows = new Map<string, Row>();
    for (const entry of parsed) { const row = this.#newRow(entry, null); rows.set(row.id, row); }
    this.#budget(rows);
    this.#rows = rows; this.#roots = [...rows.keys()]; this.#rootTotal = total; this.#selected = null; this.#focused = this.#roots[0] ?? null;
  }
  appendRoots(entries: readonly TreeEntry[]): void {
    const parsed = entries.map(readTreeEntry), seen = new Set(this.#roots.map(id => this.#row(id).entry.node.id));
    for (const entry of parsed) { if (seen.has(entry.node.id)) throw new BoundaryError('STALE_TARGET'); seen.add(entry.node.id); }
    if (seen.size > this.#rootTotal) throw new BoundaryError('STATE_UNAVAILABLE');
    const rows = new Map(this.#rows), roots = [...this.#roots];
    for (const entry of parsed) { const row = this.#newRow(entry, null); rows.set(row.id, row); roots.push(row.id); }
    this.#budget(rows); this.#rows = rows; this.#roots = roots;
  }
  clear(): void { ++this.#generation; this.#rows.clear(); this.#roots = []; this.#rootTotal = 0; this.#selected = null; this.#focused = null; }
  loadedProof(id: string): { query: NonNullable<TreeEntry['query']>; proof: TreePageProof } | undefined {
    const row = this.#rows.get(id);
    if (!row?.entry.query || row.phase !== 'ready' || this.#stale(row) || !row.proof.resourceVersion) return undefined;
    return { query: row.entry.query, proof: row.proof };
  }
  #ancestorBlocked(row: Row): boolean {
    const parent = row.parent ? this.#rows.get(row.parent) : undefined;
    return parent ? parent.stale || parent.phase === 'loading' || this.#ancestorBlocked(parent) : false;
  }
  #stale(row: Row): boolean {
    if (row.stale) return true;
    return this.#ancestorBlocked(row);
  }
  begin(id: string, append = false, expandOnSettle = false): TreeTicket | null {
    const row = this.#row(id);
    if (!row.entry.query || this.#ancestorBlocked(row)) return null;
    if (append && (row.phase !== 'ready' || row.stale || !row.cursor)) return null;
    row.opening = expandOnSettle && !row.expanded ? true : undefined;
    row.phase = 'loading'; row.stale = row.children.length > 0; row.error = null; row.revision++;
    return Object.freeze({ id, generation: this.#generation, revision: row.revision, query: row.entry.query,
      cursor: append ? row.cursor ?? undefined : undefined, previous: row.proof, append });
  }
  current(ticket: TreeTicket): boolean {
    const row = this.#rows.get(ticket.id);
    return ticket.generation === this.#generation && row?.revision === ticket.revision && row.phase === 'loading';
  }
  apply(ticket: TreeTicket, page: TreePage): boolean {
    if (!this.current(ticket)) return false;
    const row = this.#row(ticket.id), entries = page.entries.map(readTreeEntry), proof = readTreeProof(page.proof);
    if (entries.length > 100 || new Set(entries.map(item => item.node.id)).size !== entries.length
      || (page.cursor && (page.cursor.length > 17_000 || page.cursor === ticket.cursor))) throw new BoundaryError('STATE_UNAVAILABLE');
    if (ticket.append && proof.resourceVersion !== row.proof.resourceVersion) throw new BoundaryError('STALE_TARGET');
    const oldChildren = row.children.map(id => this.#row(id));
    const byOrigin = new Map(oldChildren.map(child => [child.entry.node.id, child]));
    const rows = new Map(this.#rows);
    const remove = (id: string) => { const child = rows.get(id); if (child) for (const descendant of child.children) remove(descendant); rows.delete(id); };
    if (ticket.query.kind === 'helm-releases' && ticket.append) {
      const existingReleases = oldChildren.flatMap(child => child.entry.node.type === 'release' && child.entry.node.release ? [child.entry.node.release] : []);
      const incomingReleases = entries.flatMap(entry => entry.node.type === 'release' && entry.node.release ? [entry.node.release] : []);
      const merged = mergeHelmReleaseEntries(existingReleases, incomingReleases);
      const partial = page.cursor !== null;
      const incomingByName = new Map(entries.map(entry => [entry.node.label, entry]));
      const mergedEntries = merged.releases.map(release => {
        const existingRow = oldChildren.find(child => child.entry.node.type === 'release' && child.entry.node.label === release.name);
        const incomingEntry = incomingByName.get(release.name);
        const baseNode = existingRow?.entry.node ?? incomingEntry?.node;
        const baseQuery = existingRow?.entry.query ?? incomingEntry?.query ?? { target: ticket.query.target, kind: 'helm-release-history' as const, release: release.name, namespace: release.namespace };
        const description = `r${release.currentRevision} · ${release.currentStatus}${partial ? ' (partial)' : ''}`;
        return readTreeEntry({
          query: baseQuery,
          node: {
            id: baseNode?.id ?? `${row.entry.node.id}:release:${release.name}`,
            type: 'release',
            label: release.name,
            expandable: true,
            description,
            tooltip: partial ? `${release.name}: r${release.currentRevision} (${release.currentStatus}) — partial page` : `${release.name}: r${release.currentRevision} (${release.currentStatus})`,
            icon: release.currentStatus === 'failed' ? 'helm-failed' : 'helm-deployed',
            release,
            partial,
          },
        });
      });
      const retainedIds = new Set(mergedEntries.map(entry => entry.node.id));
      for (const old of oldChildren) if (!retainedIds.has(old.entry.node.id)) remove(old.id);
      const children: string[] = [];
      for (const entry of mergedEntries) {
        const old = byOrigin.get(entry.node.id);
        let child: Row;
        if (old) {
          const sameRelease = JSON.stringify(old.entry.node.release) === JSON.stringify(entry.node.release);
          child = sameRelease ? { ...old, entry } : { ...old, entry, opening: undefined, phase: 'idle', stale: old.children.length > 0, error: null, cursor: null, proof: { resourceVersion: null }, revision: old.revision + 1 };
        } else child = this.#newRow(entry, row.id);
        rows.set(child.id, child); children.push(child.id);
      }
      rows.set(row.id, { ...row, children, expanded: row.expanded || !!row.opening, opening: undefined, phase: 'ready', stale: false, error: null, cursor: page.cursor, proof });
      this.#budget(rows);
      let focus = this.#focused;
      while (focus && !rows.has(focus)) focus = this.#rows.get(focus)?.parent ?? null;
      this.#rows = rows;
      if (this.#selected && !rows.has(this.#selected)) this.#selected = null;
      this.#focused = focus ?? row.id;
      return true;
    }
    if (ticket.append && entries.some(entry => byOrigin.has(entry.node.id))) throw new BoundaryError('STATE_UNAVAILABLE');
    const retained = new Set(entries.map(entry => entry.node.id));
    if (!ticket.append) for (const old of oldChildren) if (!retained.has(old.entry.node.id)) remove(old.id);
    const children = ticket.append ? [...row.children] : [];
    if (ticket.query.kind === 'helm-release-history' && ticket.append && page.cursor === null) {
      for (const id of children) {
        const existing = rows.get(id);
        if (existing && existing.entry.node.type === 'revision' && existing.entry.node.partial) {
          rows.set(id, { ...existing, entry: readTreeEntry({ ...existing.entry, node: { ...existing.entry.node, partial: false } }) });
        }
      }
    }
    for (const entry of entries) {
      const old = !ticket.append ? byOrigin.get(entry.node.id) : undefined;
      let child: Row;
      if (old) {
        const unchanged = JSON.stringify(old.entry.query) === JSON.stringify(entry.query);
        const sameIdentity = sameTreeQueryIdentity(old.entry.query, entry.query);
        if (!sameIdentity) for (const descendant of old.children) remove(descendant);
        child = unchanged ? { ...old, entry } : sameIdentity ? { ...old, entry, opening: undefined, phase: 'idle', stale: old.children.length > 0, error: null, cursor: null,
          proof: { resourceVersion: null }, revision: old.revision + 1 } : { ...this.#newRow(entry, row.id), id: old.id, revision: old.revision + 1 };
      } else child = this.#newRow(entry, row.id);
      rows.set(child.id, child); children.push(child.id);
    }
    rows.set(row.id, { ...row, children, expanded: row.expanded || !!row.opening, opening: undefined, phase: 'ready', stale: false, error: null, cursor: page.cursor, proof });
    this.#budget(rows); // Whole page admission is atomic; never silently truncate a page.
    let focus = this.#focused;
    while (focus && !rows.has(focus)) focus = this.#rows.get(focus)?.parent ?? null;
    this.#rows = rows;
    if (this.#selected && !rows.has(this.#selected)) this.#selected = null;
    this.#focused = focus ?? row.id;
    return true;
  }
  fail(ticket: TreeTicket, code: ErrorCode): boolean {
    if (!this.current(ticket)) return false;
    const row = this.#row(ticket.id); row.phase = 'error'; row.stale = row.children.length > 0; row.error = code; row.cursor = null;
    if (row.opening) row.expanded = true;
    row.opening = undefined;
    return true;
  }
  cancel(id: string): void {
    for (const child of this.descendants(id, true)) {
      const row = this.#row(child);
      if (row.phase === 'loading') { row.opening = undefined; row.revision++; row.phase = 'error'; row.error = 'QUERY_CANCELLED'; row.stale = row.children.length > 0; row.cursor = null; }
    }
  }
  descendants(id: string, includeSelf = false): string[] {
    const row = this.#row(id), result = includeSelf ? [id] : [];
    for (const child of row.children) result.push(child, ...this.descendants(child));
    return result;
  }
  invalidateQueries(matches: (query: TreeQuery) => boolean): readonly string[] {
    const ids = [...this.#rows.values()].filter(row => row.entry.query && matches(row.entry.query) && (row.phase !== 'idle' || row.children.length > 0)).map(row => row.id);
    for (const id of ids) {
      this.cancel(id); const row = this.#row(id); row.revision++; row.stale = true; row.cursor = null;
    }
    return ids;
  }
  expand(id: string, defer = false): boolean {
    const row = this.#row(id);
    if (!row.entry.query || this.#ancestorBlocked(row)) return false;
    if (defer && row.phase === 'loading') {
      if (!row.expanded) row.opening = true;
      return false;
    }
    const load = row.phase === 'idle' || row.stale || (defer && row.error === 'QUERY_CANCELLED');
    if (!defer || !load) row.expanded = true;
    return load;
  }
  collapse(id: string): void {
    const row = this.#row(id); row.expanded = false; this.cancel(id);
    if (this.#focused && this.descendants(id).includes(this.#focused)) this.#focused = id;
  }
  collapseAll(): void { for (const id of this.#roots) this.collapse(id); for (const row of this.#rows.values()) row.expanded = false; }
  // A pointer selection places the keyboard cursor on the same occurrence.
  // Arrow navigation can still move focus without changing selection.
  select(id: string): void { this.#row(id); this.#selected = id; this.#focused = id; }
  focus(id: string): void { if (this.visible().some(row => row.id === id)) this.#focused = id; }
  visible(): readonly TreeRow[] {
    const result: TreeRow[] = [];
    const visit = (ids: readonly string[], level: number, partial = false) => {
      if (level > 10) throw new BoundaryError('BUDGET_EXCEEDED');
      ids.forEach((id, index) => {
        const row = this.#row(id), stale = this.#stale(row);
        result.push(Object.freeze({ id, parent: row.parent, entry: row.entry, level, position: index + 1, setSize: level === 1 ? this.#rootTotal : partial ? -1 : ids.length,
           expanded: row.expanded, ...(row.opening ? { opening: true as const } : {}), phase: row.phase, stale, error: row.error, canMore: row.phase === 'ready' && !stale && row.cursor !== null,
          empty: row.phase === 'ready' && !stale && row.children.length === 0 && row.cursor === null,
          selected: id === this.#selected, focused: id === this.#focused }));
        if (row.expanded) visit(row.children, level + 1, !!row.cursor);
      });
    };
    visit(this.#roots, 1);
    return Object.freeze(result);
  }
  keyboard(key: string): { kind: 'expand' | 'collapse'; id: string } | null {
    const rows = this.visible(), index = rows.findIndex(row => row.id === this.#focused), current = rows[index];
    if (!current) { this.#focused = rows[0]?.id ?? null; return null; }
    if (key === 'ArrowDown') this.#focused = rows[Math.min(index + 1, rows.length - 1)]?.id ?? current.id;
    else if (key === 'ArrowUp') this.#focused = rows[Math.max(0, index - 1)]?.id ?? current.id;
    else if (key === 'Home') this.#focused = rows[0]?.id ?? current.id;
    else if (key === 'End') this.#focused = rows.at(-1)?.id ?? current.id;
    else if (key === 'ArrowRight') {
      if (!current.expanded && !current.opening && current.entry.query) return { kind: 'expand', id: current.id };
      if (current.expanded) this.#focused = this.#row(current.id).children[0] ?? current.id;
    } else if (key === 'ArrowLeft') {
      if (current.expanded || current.opening) return { kind: 'collapse', id: current.id };
      if (current.parent) this.#focused = current.parent;
    } else if (key === ' ' || key === 'Space' || key === 'Enter') this.#selected = current.id;
    return null; // Selection never invokes Load/Exec/operations or toggles expansion.
  }
  get generation() { return this.#generation; }
  get size() { return this.#rows.size; }
}
