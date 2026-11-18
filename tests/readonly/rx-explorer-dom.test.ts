// Pure DOM + pure action description tests (zero cluster/write execution handlers, zero tree-view.ts imports).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  explorerNodeActions,
  explorerTitleActions,
} from '../../src/shared/explorer-actions.ts';
import type { TreeSnapshot } from '../../src/host/tree-controller.ts';
import type { TreeRow } from '../../src/shared/tree-model.ts';
import { createTreeRenderer } from '../../src/panel/tree-renderer.ts';
import { mountHelmRepoTreeView } from '../../src/panel/helm-repo-tree-view.ts';
import { mountRequestDiagnosticsView } from '../../src/panel/request-diagnostics-view.ts';
import { inspectionTextTokens, inspectionHighlightTokenLimit, renderInspectionText } from '../../src/panel/inspection-text.ts';
import { treeIconStatus } from '../../src/panel/explorer-icons.ts';
import { logDisplayText } from '../../src/shared/pod-log-protocol.ts';
import { inspectionSyntaxTheme } from '../../src/shared/presentation-theme.ts';
import { HostSnapshotLifecycle } from '../../src/host/host-snapshot-lifecycle.ts';
import { mountTaskTabs } from '../../src/panel/task-tabs.ts';
import { disclosure, mountOperationSummary } from '../../src/panel/presentation.ts';

type ListenerEntry = { readonly fn: (event: unknown) => void; readonly capture: boolean };

function createSyntheticDom(viewport = { width: 720, height: 480 }) {
  class SyntheticClassList {
    readonly #set = new Set<string>();
    add(...tokens: string[]) { for (const t of tokens) if (t) this.#set.add(t); }
    remove(...tokens: string[]) { for (const t of tokens) this.#set.delete(t); }
    contains(token: string) { return this.#set.has(token); }
    sync(raw: string) {
      this.#set.clear();
      for (const part of raw.split(/\s+/).filter(Boolean)) this.#set.add(part);
    }
    toString() { return [...this.#set].join(' '); }
  }

  class SyntheticNode {
    parentNode: SyntheticNode | null = null;
    readonly childNodes: SyntheticNode[] = [];
    readonly #listeners = new Map<string, ListenerEntry[]>();
    #document: SyntheticDocument;

    constructor(doc: SyntheticDocument) {
      this.#document = doc;
    }

    get ownerDocument() { return this.#document; }

    get isConnected(): boolean {
      if (this === (this.#document.documentElement as unknown as SyntheticNode)) return true;
      let cur = this.parentNode;
      while (cur) {
        if (cur === this.#document.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    append(...nodes: Array<SyntheticNode | string>) {
      for (const n of nodes) {
        const node = typeof n === 'string' ? new SyntheticTextNode(this.#document, n) : n;
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }

    appendChild<T extends SyntheticNode>(node: T): T {
      this.append(node);
      return node;
    }
    insertBefore<T extends SyntheticNode>(node: T, reference: SyntheticNode | null): T {
      if (!reference) return this.appendChild(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = this.childNodes.indexOf(reference);
      if (index < 0) throw new Error('Synthetic reference not found');
      node.parentNode = this; this.childNodes.splice(index, 0, node); return node;
    }

    get firstChild(): SyntheticNode | null {
      return this.childNodes[0] ?? null;
    }

    prepend(...nodes: Array<SyntheticNode | string>) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        const node = typeof n === 'string' ? new SyntheticTextNode(this.#document, n) : n;
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.unshift(node);
      }
    }

    removeChild(node: SyntheticNode) {
      const idx = this.childNodes.indexOf(node);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        node.parentNode = null;
      }
    }

    replaceChildren(...nodes: Array<SyntheticNode | string>) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes.length = 0;
      this.append(...nodes);
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    contains(other: SyntheticNode | null): boolean {
      let cur: SyntheticNode | null = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    addEventListener(type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean; once?: boolean }) {
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      const once = typeof options === 'object' && !!options?.once;
      const wrapped = once
        ? (ev: unknown) => {
            this.removeEventListener(type, wrapped, capture);
            fn(ev);
          }
        : fn;
      const list = this.#listeners.get(type) ?? [];
      list.push({ fn: wrapped, capture });
      this.#listeners.set(type, list);
    }

    removeEventListener(type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      const list = this.#listeners.get(type);
      if (!list) return;
      const next = list.filter(item => !(item.fn === fn && item.capture === capture));
      this.#listeners.set(type, next);
    }

    dispatchEvent(rawEvent: Record<string, unknown>): boolean {
      let propagationStopped = false;
      let defaultPrevented = false;
      const event: Record<string, unknown> = {
        ...rawEvent,
        target: rawEvent.target ?? this,
        currentTarget: this,
        defaultPrevented: false,
        preventDefault: () => {
          defaultPrevented = true;
          event.defaultPrevented = true;
        },
        stopPropagation: () => {
          propagationStopped = true;
        },
      };
      const path: SyntheticNode[] = [this];
      let cur = this.parentNode;
      while (cur) {
        path.unshift(cur);
        cur = cur.parentNode;
      }
      // Capture phase (ancestors down to target exclusive)
      for (let i = 0; i < path.length - 1 && !propagationStopped; i++) {
        const node = path[i]!;
        event.currentTarget = node;
        for (const entry of (node.#listeners.get(String(event.type)) ?? []).slice()) {
          if (entry.capture) entry.fn(event);
          if (propagationStopped) break;
        }
      }
      // Target phase
      if (!propagationStopped) {
        event.currentTarget = this;
        for (const entry of (this.#listeners.get(String(event.type)) ?? []).slice()) {
          entry.fn(event);
          if (propagationStopped) break;
        }
      }
      // Bubble phase
      for (let i = path.length - 2; i >= 0 && !propagationStopped; i--) {
        const node = path[i]!;
        event.currentTarget = node;
        for (const entry of (node.#listeners.get(String(event.type)) ?? []).slice()) {
          if (!entry.capture) entry.fn(event);
          if (propagationStopped) break;
        }
      }
      return !defaultPrevented;
    }
  }

  class SyntheticTextNode extends SyntheticNode {
    textContent: string;
    constructor(doc: SyntheticDocument, text: string) {
      super(doc);
      this.textContent = text;
    }
  }

  class SyntheticElement extends SyntheticNode {
    readonly tagName: string;
    readonly attributes = new Map<string, string>();
    readonly classList = new SyntheticClassList();
    readonly style: Record<string, unknown>;
    readonly dataset: Record<string, string>;
    tabIndex = -1;
    disabled = false;
    hidden = false;
    title = '';
    type = '';
    value = '';
    rect = { left: 10, top: 20, right: 120, bottom: 42, width: 110, height: 22 };
    #text = '';

    constructor(doc: SyntheticDocument, tagName: string) {
      super(doc);
      this.tagName = tagName.toUpperCase();
      const props = new Map<string, string>();
      this.style = new Proxy({} as Record<string, unknown>, {
        set: (target, prop, val) => {
          target[String(prop)] = val;
          return true;
        },
        get: (target, prop) => {
          if (prop === 'setProperty') return (k: string, v: string) => { props.set(k, v); };
          if (prop === 'getPropertyValue') return (k: string) => props.get(k) ?? '';
          return target[String(prop)] ?? '';
        },
      });
      this.dataset = new Proxy({} as Record<string, string>, {
        set: (_t, prop, val) => {
          const attr = `data-${String(prop).replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
          this.attributes.set(attr, String(val));
          return true;
        },
        get: (_t, prop) => {
          const attr = `data-${String(prop).replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
          return this.attributes.get(attr);
        },
      });
    }

    get id() { return this.getAttribute('id') ?? ''; }
    set id(val: string) { this.setAttribute('id', val); }
    get className() { return this.classList.toString(); }
    set className(val: string) { this.classList.sync(val); }

    get textContent(): string {
      if (this.childNodes.length === 0) return this.#text;
      return this.childNodes.map(c => (c instanceof SyntheticTextNode || c instanceof SyntheticElement) ? c.textContent : '').join('');
    }
    set textContent(val: string) {
      this.#text = String(val ?? '');
      this.replaceChildren();
    }

    setAttribute(name: string, val: string) {
      this.attributes.set(name, String(val));
      if (name === 'tabindex') this.tabIndex = Number.parseInt(val, 10);
    }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    get children(): SyntheticElement[] { return this.childNodes.filter((node): node is SyntheticElement => node instanceof SyntheticElement); }
    closest(selector: string): SyntheticElement | null {
      if (this.matchesSelector(selector)) return this;
      return this.parentNode instanceof SyntheticElement ? this.parentNode.closest(selector) : null;
    }

    focus() {
      if (this.isConnected) this.ownerDocument.activeElement = this;
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', button: 0 });
    }
    getBoundingClientRect() {
      if (this.classList.contains('oc-k8s-action-menu')) {
        return { left: 0, top: 0, right: 220, bottom: 240, width: 220, height: 240 };
      }
      return this.rect;
    }

    matchesSelector(selector: string): boolean {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attrMatch = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attrMatch) {
        const [, name, expected] = attrMatch;
        if (expected === undefined) return this.hasAttribute(name!);
        return this.getAttribute(name!) === expected;
      }
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    querySelector(selector: string): SyntheticElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector: string): SyntheticElement[] {
      const results: SyntheticElement[] = [];
      const walk = (node: SyntheticNode) => {
        for (const child of node.childNodes) {
          if (child instanceof SyntheticElement) {
            if (child.matchesSelector(selector)) results.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return results;
    }
  }

  class SyntheticDocument extends SyntheticNode {
    readonly documentElement: SyntheticElement;
    readonly body: SyntheticElement;
    readonly head: SyntheticElement;
    activeElement: SyntheticElement | null = null;
    readonly defaultView: Record<string, unknown>;

    constructor() {
      super(null as unknown as SyntheticDocument);
      this.documentElement = new SyntheticElement(this, 'html');
      this.head = new SyntheticElement(this, 'head');
      this.body = new SyntheticElement(this, 'body');
      this.documentElement.append(this.head, this.body);
      this.append(this.documentElement);
      const viewListeners = new Map<string, Array<(ev: unknown) => void>>();
      this.defaultView = {
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        addEventListener: (type: string, fn: (ev: unknown) => void) => {
          const list = viewListeners.get(type) ?? [];
          list.push(fn);
          viewListeners.set(type, list);
        },
        removeEventListener: (type: string, fn: (ev: unknown) => void) => {
          const list = viewListeners.get(type) ?? [];
          viewListeners.set(type, list.filter(f => f !== fn));
        },
      };
    }

    override get ownerDocument() { return this; }
    createElement(tag: string) { return new SyntheticElement(this, tag); }
    createElementNS(_ns: string, tag: string) { return new SyntheticElement(this, tag); }
    getElementById(id: string) {
      return this.documentElement.querySelectorAll('*').find(el => el.getAttribute('id') === id) ?? null;
    }
  }

  const doc = new SyntheticDocument();
  return { doc, document: doc as unknown as Document, ElementClass: SyntheticElement };
}

function makeRow(overrides: Partial<TreeRow> & { id: string; node: TreeRow['entry']['node'] }): TreeRow {
  return {
    id: overrides.id,
    parent: overrides.parent ?? null,
    level: overrides.level ?? 1,
    position: overrides.position ?? 1,
    setSize: overrides.setSize ?? 1,
    expanded: overrides.expanded ?? false,
    phase: overrides.phase ?? 'ready',
    stale: overrides.stale ?? false,
    error: overrides.error ?? null,
    canMore: overrides.canMore ?? false,
    empty: overrides.empty ?? false,
    selected: overrides.selected ?? false,
    focused: overrides.focused ?? false,
    entry: {
      node: overrides.node,
      query: overrides.entry?.query ?? null,
    },
  };
}

test('host snapshots retain the same task DOM, nested disclosure state, drafts, scroll and focused element', () => {
  const { document } = createSyntheticDom(), host = document.createElement('div'); document.body.append(host);
  const tasks = mountTaskTabs(document, host, [{ id: 'a', label: 'A', zh: '甲' }, { id: 'b', label: 'B', zh: '乙' }], () => 'zh');
  const input = document.createElement('textarea'); input.value = 'unsaved synthetic draft';
  const details = disclosure(document, tasks.slots.a!, 'Details'); details.element.open = true;
  const nested = disclosure(document, details.body, 'Nested'); nested.element.open = true; nested.body.append(input);
  input.focus(); host.scrollTop = 218; host.scrollLeft = 37;
  const first = tasks.slots.a!.firstChild, focused = document.activeElement;
  const lifecycle = new HostSnapshotLifecycle(); lifecycle.ready('/synthetic/a');
  let resets = 0;
  for (let index = 0; index < 100; index++) {
    if (lifecycle.ready('/synthetic/a').projectChanged || lifecycle.directory('/synthetic/a')) resets++;
    tasks.paint();
  }
  assert.equal(resets, 0); assert.equal(tasks.slots.a!.firstChild, first);
  assert.equal(document.activeElement, focused); assert.equal(input.value, 'unsaved synthetic draft');
  assert.equal(details.element.open, true); assert.equal(nested.element.open, true);
  assert.equal(host.scrollTop, 218); assert.equal(host.scrollLeft, 37);
  tasks.show('b'); host.scrollTop = 42; tasks.show('a');
  assert.equal(host.scrollTop, 218); assert.equal(tasks.slots.a!.contains(input), true); assert.equal(nested.element.open, true);
  tasks.dispose();
});

test('operation summary keeps unknown outcomes, target and actual replica change visible; proof disclosure remains open across updates', () => {
  const { document } = createSyntheticDom(), section = document.createElement('section'), raw = document.createElement('p');
  document.body.append(section); section.append(raw);
  const summary = mountOperationSummary(document, section, raw, () => 'zh');
  const state = { phase: 'result', outcome: { phase: 'unknown', target: { context: 'synthetic', namespace: 'web' }, reference: { name: 'api' }, parameters: { replicas: 0 }, code: 'STATE_UNAVAILABLE' } };
  summary.show(state);
  assert.match(section.textContent ?? '', /结果未知.*勿重复提交/); assert.match(section.textContent ?? '', /synthetic \/ web \/ api/);
  assert.match(section.textContent ?? '', /目标副本数: 0/);
  const details = section.querySelector('details') as HTMLDetailsElement; details.open = true;
  summary.show(state); assert.equal(details.open, true);
  assert.equal(raw.getAttribute('role'), null);
});

test('inspection highlighting preserves every character and distinguishes keys, failed/waiting/ready values and exit codes', () => {
  const text = 'Name:  synthetic-pod\r\nContainers:\r\n  State: Waiting\r\n  Reason: CrashLoopBackOff\r\n  Ready: False\r\n  Exit Code: 1\r\n  Last State: Terminated\r\n  Exit Code: 0\r\n  Memory: 128Mi\r\n';
  const tokens = inspectionTextTokens(text);
  assert.equal(tokens.map(token => token.text).join(''), text);
  for (const [word, tone] of [['Name:', 'key'], ['Containers:', 'heading'], ['Waiting', 'warning'], ['CrashLoopBackOff', 'error'], ['False', 'error'], ['128Mi', 'number']]) {
    assert.ok(tokens.some(token => token.text.trim() === word && token.tone === tone), `${word}: ${tone}`);
  }
  assert.ok(tokens.some(token => token.text === '1' && token.tone === 'error'));
  assert.ok(tokens.some(token => token.text === '0' && token.tone === 'success'));
  assert.ok(!tokens.some(token => token.text === 'Terminated' && token.tone === 'error'));
});

test('inspection renderer uses text nodes/spans only, never turns resource text, URLs or ANSI into active markup', () => {
  const { document } = createSyntheticDom(), pre = document.createElement('pre');
  const text = logDisplayText('Name: <img src=x onerror=alert(1)>\nAddress: https://synthetic.invalid\nReason: CrashLoopBackOff\nControl: \u001b[31mtext\u001b[0m\n');
  renderInspectionText(document, pre, text);
  assert.equal(pre.textContent, text);
  assert.equal(pre.querySelectorAll('img').length, 0); assert.equal(pre.querySelectorAll('a').length, 0);
  assert.ok(pre.querySelector('.oc-k8s-syntax-error'));
  assert.ok(pre.textContent?.includes('\\u001b'));
});

test('syntax highlighting has a DOM token ceiling for both long single lines and many lines without truncating content', () => {
  for (const text of ['Running 1 '.repeat(100_000), 'Status: Running\n'.repeat(80_000)]) {
    const tokens = inspectionTextTokens(text);
    assert.ok(tokens.length <= inspectionHighlightTokenLimit + 1, `${tokens.length} tokens`);
    assert.equal(tokens.map(token => token.text).join(''), text);
    assert.equal(tokens.at(-1)?.tone, 'plain');
  }
});

test('optional SDK syntax tokens fall back to host semantic text colours and do not keep stale values after a theme switch', () => {
  const semantic = { primaryText: 'synthetic-primary', infoText: 'synthetic-info' };
  const custom = inspectionSyntaxTheme({ ...semantic, syntaxKeyword: 'theme-keyword', syntaxType: 'theme-type', syntaxNumber: 'theme-number' });
  assert.equal(custom['--oc-k8s-code-key'], 'theme-keyword');
  assert.equal(custom['--oc-k8s-code-heading'], 'theme-type');
  assert.equal(custom['--oc-k8s-code-number'], 'theme-number');
  const fallback = inspectionSyntaxTheme({ ...semantic, syntaxKeyword: '', syntaxType: ' ' });
  assert.equal(fallback['--oc-k8s-code-key'], semantic.primaryText);
  assert.equal(fallback['--oc-k8s-code-heading'], semantic.primaryText);
  assert.equal(fallback['--oc-k8s-code-number'], semantic.infoText);
});

test('tree status remains understandable without colour through localized names, shapes and accessible row labels', () => {
  const { document } = createSyntheticDom(), host = document.createElement('div');
  document.body.append(host);
  const renderer = createTreeRenderer(document, host, { onSelect() {}, onExpand() {}, onCollapse() {}, onMore() {}, onKeyboard() {}, onCommand() {}, isZh: () => true });
  const row = makeRow({ id: 'pod-error', node: { id: 'pod-error', type: 'resource', label: 'synthetic-pod', expandable: false, icon: 'pod-error' } });
  renderer.render({ generation: 1, rows: [row], roots: { phase: 'ready', stale: false, error: null }, message: undefined } as unknown as TreeSnapshot);
  assert.equal(host.querySelector('[role="treeitem"]')?.getAttribute('aria-label'), 'synthetic-pod · 运行异常');
  assert.ok(host.querySelector('[class="oc-k8s-icon oc-k8s-icon-pod-error"]'));
  assert.equal(treeIconStatus('workload-ready', false), 'Deployment ready');
  assert.equal(treeIconStatus('workload-progressing', true), '部署中 · 未完全就绪');
  renderer.dispose();
});

test('RX-A06: explorerTitleActions and explorerNodeActions cover upstream groupings, inline icons, watchable folders, and apps/batch/CRD Delete without slice(0,12) truncation', () => {
  const titleItems = explorerTitleActions({ view: 'clusters', zh: false, hasConfig: true, hasActiveContext: true });
  assert.ok(titleItems.some(i => i.id === 'extension.vsKubernetesRefreshExplorer' && i.inline));
  assert.ok(titleItems.some(i => i.id === 'openchamber.k8s.collapseAll' && i.inline));
  assert.ok(titleItems.some(i => i.id === 'extension.vsKubernetesUseKubeconfig' && i.inline));
  assert.ok(titleItems.some(i => i.id === 'openchamber.k8s.openRequestDiagnostics'));

  // Inactive vs active context
  const inactiveCtx = explorerNodeActions({
    node: { id: 'c1', type: 'context', label: 'staging', expandable: false },
    zh: false, stale: false, configReady: true, hasActiveContext: true,
  });
  assert.ok(inactiveCtx.some(i => i.id === 'extension.vsKubernetesUseContext'));
  assert.ok(inactiveCtx.some(i => i.id === 'extension.vsKubernetesDeleteContext' && i.destructive));

  const minikubeCtx = explorerNodeActions({
    node: { id: 'c2', type: 'context', label: 'minikube', expandable: true, icon: 'minikube' },
    zh: false, stale: false, configReady: true, hasActiveContext: true,
  });
  assert.ok(minikubeCtx.some(i => i.id === 'extension.vsMinikubeStart'));
  assert.ok(minikubeCtx.some(i => i.id === 'extension.vsMinikubeStatus'));

  // Watchable folder includes Watch, Stop Watching, and Get without truncation
  const folderItems = explorerNodeActions({
    node: { id: 'f-pods', type: 'folder', label: 'Pods', expandable: true },
    zh: false, stale: false, configReady: true, hasActiveContext: true,
  });
  assert.deepEqual(
    folderItems.map(i => i.id),
    ['openchamber.k8s.refreshBranch', 'extension.vsKubernetesGet', 'extension.vsKubernetesAddWatch', 'extension.vsKubernetesDeleteWatch'],
  );

  // Pod includes 3 inline actions (Describe, Logs, Terminal) + full menu (Delete, Port Forward, Debug, etc.) with > 12 items preserved!
  const podItems = explorerNodeActions({
    node: {
      id: 'pod-1', type: 'resource', label: 'web-0', expandable: true,
      resource: { group: '', version: 'v1', resource: 'pods', scope: 'namespace', kind: 'Pod', name: 'web-0', namespace: 'default', uid: 'u-pod', resourceVersion: '1' },
    },
    zh: false, stale: false, configReady: true, hasActiveContext: true,
  });
  assert.deepEqual(
    podItems.filter(i => i.inline).map(i => i.icon).sort(),
    ['describe', 'logs', 'terminal'],
  );
  assert.ok(podItems.some(i => i.id === 'extension.vsKubernetesDelete'));
  assert.ok(podItems.some(i => i.id === 'extension.vsKubernetesDeleteNow'));
  assert.ok(podItems.some(i => i.id === 'extension.vsKubernetesPortForward'));
  assert.ok(podItems.some(i => i.id === 'extension.vsKubernetesDebugAttach'));

  // Deployment (apps), Job (batch), and Custom Resource ALL include Delete
  for (const [label, group, resource, kind] of [
    ['api', 'apps', 'deployments', 'Deployment'],
    ['nightly', 'batch', 'jobs', 'Job'],
    ['widget-1', 'sample.test', 'widgets', 'Widget'],
  ] as const) {
    const items = explorerNodeActions({
      node: {
        id: `res-${label}`, type: 'resource', label, expandable: true,
        resource: { group, version: 'v1', resource, scope: 'namespace', kind, name: label, namespace: 'default', uid: `u-${label}`, resourceVersion: '2' },
      },
      zh: false, stale: false, configReady: true, hasActiveContext: true,
      isCustomResource: group === 'sample.test',
    });
    assert.ok(items.some(i => i.id === 'extension.vsKubernetesDelete'), `${kind} must show Delete`);
    if (resource === 'deployments' || resource === 'jobs') {
      assert.ok(items.some(i => i.id === 'extension.vsKubernetesScale'), `${kind} must show Scale`);
    }
    if (resource === 'jobs') {
      assert.ok(items.some(i => i.id === 'extension.vsKubernetesLogs'), 'Job must show Logs');
    }
  }
});

test('RX-A07 / RX-A02 / RX-D2: right-click B with A selected binds B only, survives redraw, edge-flips, supports keyboard menu and touch ⋯, and single-click selects without loading', () => {
  const { doc, document } = createSyntheticDom({ width: 720, height: 480 });
  const host = document.createElement('div');
  const overlayHost = document.createElement('div');
  doc.body.append(host as never, overlayHost as never);

  const selectedIds: string[] = [];
  const commands: Array<{ command: string; rowId: string }> = [];
  const keyboards: string[] = [];
  const expansions: string[] = [];

  const renderer = createTreeRenderer(document, host, {
    onSelect: id => selectedIds.push(id),
    onExpand: id => expansions.push(`expand:${id}`),
    onCollapse: id => expansions.push(`collapse:${id}`),
    onMore: () => {},
    onKeyboard: key => keyboards.push(key),
    onCommand: (command, row) => commands.push({ command, rowId: row.id }),
  }, overlayHost);

  const rowA = makeRow({
    id: 'row-a',
    position: 1,
    setSize: 2,
    selected: true,
    focused: true,
    node: {
      id: 'row-a', type: 'resource', label: 'pod-a-very-long-kubernetes-workload-name-that-stays-single-line', expandable: true,
      resource: { group: '', version: 'v1', resource: 'pods', scope: 'namespace', kind: 'Pod', name: 'pod-a', namespace: 'default', uid: 'uid-a', resourceVersion: '10' },
    },
  });
  const rowB = makeRow({
    id: 'row-b',
    position: 2,
    setSize: 2,
    selected: false,
    focused: false,
    node: {
      id: 'row-b', type: 'resource', label: 'pod-b', expandable: true,
      resource: { group: '', version: 'v1', resource: 'pods', scope: 'namespace', kind: 'Pod', name: 'pod-b', namespace: 'default', uid: 'uid-b', resourceVersion: '20' },
    },
  });

  const snap1: TreeSnapshot = {
    roots: { phase: 'ready', total: 1, nextOffset: null, error: null, available: true },
    generation: 1,
    message: null,
    rows: [rowA, rowB],
  };
  renderer.render(snap1);

  // Single-click on A selects ONLY (0 commands fired)
  const elA = host.querySelector('[data-row-id="row-a"]')!;
  const elB = host.querySelector('[data-row-id="row-b"]')!;
  (elA as unknown as { dispatchEvent: (ev: Record<string, unknown>) => boolean }).dispatchEvent({ type: 'click' });
  assert.deepEqual(selectedIds, ['row-a']);
  assert.equal(commands.length, 0);

  // Double-click expands, never opens content or dispatches a resource command.
  (elA as unknown as { dispatchEvent: (ev: Record<string, unknown>) => boolean }).dispatchEvent({ type: 'dblclick' });
  assert.deepEqual(expansions, ['expand:row-a']);
  assert.equal(commands.length, 0);

  // Right-click B near bottom-right corner (700, 460) while A is selected
  (elB as unknown as { dispatchEvent: (ev: Record<string, unknown>) => boolean }).dispatchEvent({
    type: 'contextmenu', clientX: 700, clientY: 460,
  });
  assert.deepEqual(selectedIds, ['row-a'], 'right-click B must NOT alter selection A');
  assert.equal(renderer.menu.isOpen(), true);
  const menuEl = overlayHost.querySelector('[role="menu"]') as unknown as {
    style: Record<string, string>;
    querySelectorAll: (s: string) => Array<{ dataset: Record<string, string>; textContent: string }>;
    dispatchEvent: (ev: Record<string, unknown>) => void;
  };
  assert.ok(menuEl);
  // Edge flip checks: left <= 720 - 220 = 500, top <= 480 - 240 = 240
  assert.ok(Number.parseInt(menuEl.style.left!, 10) <= 500);
  assert.ok(Number.parseInt(menuEl.style.top!, 10) <= 240);
  // Separators present for grouped items
  assert.ok(overlayHost.querySelectorAll('[role="separator"]').length >= 1);

  // Re-render tree with same generation & rowB unchanged -> menu must remain open and connected in overlayHost!
  renderer.render({
    ...snap1,
    rows: [
      { ...rowA, selected: false, focused: false },
      { ...rowB, selected: true, focused: true },
    ],
  });
  assert.equal(renderer.menu.isOpen(), true);
  assert.ok(overlayHost.querySelector('[role="menu"]'));

  // Escape restores focus to the same live row node retained through redraws.
  menuEl.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(renderer.menu.isOpen(), false);
  assert.equal(keyboards.length, 0, 'menu Escape must not bubble to tree keyboard');
  const liveElB = host.querySelector('[data-row-id="row-b"]');
  assert.equal(liveElB, elB);
  assert.equal(doc.activeElement, liveElB as unknown);

  // Touch / accessibility `⋯` button opens menu and Enter executes on B
  const moreBtn = (liveElB as unknown as { querySelector: (s: string) => { click: () => void } }).querySelector('.oc-k8s-tree-menu-button');
  moreBtn.click();
  assert.equal(renderer.menu.isOpen(), true);
  const menuEl2 = overlayHost.querySelector('[role="menu"]') as unknown as {
    dispatchEvent: (ev: Record<string, unknown>) => void;
  };
  menuEl2.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  menuEl2.dispatchEvent({ type: 'keydown', key: 'Home' });
  menuEl2.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(renderer.menu.isOpen(), false);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.rowId, 'row-b');

  // Re-opening menu then switching generation closes stale menu automatically
  moreBtn.click();
  assert.equal(renderer.menu.isOpen(), true);
  renderer.render({ ...snap1, generation: 2 });
  assert.equal(renderer.menu.isOpen(), false);

  renderer.dispose();
});

test('double-click uses live expansion state after selection redraws, ignores leaves and controls, and never opens content', () => {
  const { document } = createSyntheticDom(), host = document.createElement('div');
  document.body.append(host);
  let row = makeRow({ id: 'folder', node: { id: 'folder', type: 'folder', label: 'Pods', expandable: true } });
  const events: string[] = [];
  const snapshot = (): TreeSnapshot => ({
    roots: { phase: 'ready', total: 1, nextOffset: null, error: null, available: true },
    generation: 1, message: null, rows: [row],
  });
  const renderer = createTreeRenderer(document, host, {
    onSelect(id) { events.push(`select:${id}`); row = { ...row, selected: true }; renderer.render(snapshot()); },
    onExpand(id) { events.push(`expand:${id}`); row = { ...row, expanded: true }; renderer.render(snapshot()); },
    onCollapse(id) { events.push(`collapse:${id}`); row = { ...row, expanded: false }; renderer.render(snapshot()); },
    onMore: () => events.push('more'), onKeyboard: key => events.push(key), onCommand: () => events.push('command'),
  });
  renderer.render(snapshot());
  const item = host.querySelector('[role="treeitem"]')!;
  const label = item.querySelector('.oc-k8s-tree-label');
  const send = (type: string, target = item) => (target as unknown as { dispatchEvent(event: Record<string, unknown>): void }).dispatchEvent({ type });
  send('click'); send('click');
  assert.equal(host.querySelector('[role="treeitem"]'), item);
  assert.equal(item.querySelector('.oc-k8s-tree-label'), label, 'selection must retain the connected double-click target');
  assert.deepEqual(events, ['select:folder', 'select:folder']);
  send('dblclick');
  assert.equal(item.getAttribute('aria-expanded'), 'true');
  send('click'); send('dblclick');
  assert.equal(item.getAttribute('aria-expanded'), 'false');
  assert.equal(events.filter(value => value === 'expand:folder').length, 1);
  assert.equal(events.filter(value => value === 'collapse:folder').length, 1);
  events.length = 0;
  send('dblclick', item.querySelector('button')!);
  assert.deepEqual(events, [], 'control double-click must not toggle the row');
  row = { ...row, stale: true }; renderer.render(snapshot()); send('dblclick');
  assert.deepEqual(events, [], 'stale closed branches cannot start a read');
  row = { ...row, expanded: true }; renderer.render(snapshot()); send('dblclick');
  assert.deepEqual(events, ['collapse:folder'], 'stale expanded branches can still collapse');
  events.length = 0;
  row = { ...row, stale: false, entry: { ...row.entry, node: { ...row.entry.node, expandable: false } } };
  renderer.render(snapshot()); send('dblclick');
  assert.deepEqual(events, [], 'leaf double-click never dispatches a default content command');
  assert.equal(item.hasAttribute('aria-expanded'), false);
  renderer.dispose();
});

test('RX-A15 / RX-A17: Helm Repos tree browses local index with 0 cluster calls and Request Diagnostics renders sanitized telemetry', async () => {
  const { doc, document, ElementClass } = createSyntheticDom();
  const helmHost = document.createElement('div');
  const diagHost = document.createElement('div');
  doc.body.append(helmHost as never, diagHost as never);

  const helmCommands: Array<{ command: string; chartRef?: string; version?: string }> = [];
  const helmView = mountHelmRepoTreeView(document, helmHost, () => undefined, () => 'en', (command, target) => {
    helmCommands.push({
      command,
      ...(target?.chartRef ? { chartRef: target.chartRef } : {}),
      ...(target?.version ? { version: target.version } : {}),
    });
  });

  helmView.update({
    phase: 'ready',
    stale: false,
    page: {
      branch: { kind: 'repositories' },
      total: 1,
      nextOffset: null,
      nodes: [{ id: 'repo:bitnami', kind: 'repository', label: 'bitnami', repository: 'bitnami', expandable: true }],
    } as never,
  });
  const repoRow = helmHost.querySelector('[data-node-id="repo:bitnami"]') as unknown as { dispatchEvent: (ev: Record<string, unknown>) => void };
  assert.ok(repoRow);

  // Drill down into chart & version without cluster calls
  helmView.update({
    phase: 'ready',
    stale: false,
    page: {
      branch: { kind: 'versions', repository: 'bitnami', chart: 'nginx' },
      total: 1,
      nextOffset: null,
      nodes: [{ id: 'ver:bitnami/nginx:18.0.0', kind: 'version', label: '18.0.0', repository: 'bitnami', chart: 'nginx', version: '18.0.0', appVersion: '1.27', expandable: false, tooltip: 'bitnami/nginx@18.0.0' }],
    } as never,
  });
  const verRow = helmHost.querySelector('[data-node-id="ver:bitnami/nginx:18.0.0"]') as unknown as { dispatchEvent: (ev: Record<string, unknown>) => void };
  assert.ok(verRow);
  verRow.dispatchEvent({ type: 'dblclick' });
  assert.deepEqual(helmCommands, [{ command: 'extension.helmInspectChart', chartRef: 'bitnami/nginx', version: '18.0.0' }]);

  const diagBridge = {
    readRequestDiagnostics: async () => ({
      limits: { concurrency: 2, tokensPerSecond: 2, burst: 2, queued: 16, timeoutMs: 12000, backgroundMaxSlots: 1 },
      inFlight: 0, inFlightBackground: 0, queued: 0, tokensAvailable: 2,
      logicalIntents: 3, transportCalls: 2, observableHttpRequests: 2, coalescedLogical: 1,
      queueWaits: 0, totalQueueWaitMs: 0, totalDurationMs: 15, responseBytes: 512,
      cancelledQueued: 0, cancelledRunning: 0, rejectedLimit: 0, rejectedCooldown: 0, timedOut: 0, rateDelayed: 0,
      status401: 0, status403: 0, status410: 0, status429: 0, retryAfterObserved: 0, activeCooldowns: 0,
      recent: [{ kind: 'tree:children', purpose: 'resource-list', priority: 'manual', outcome: 'ok', status: 200, queueWaitMs: 0, durationMs: 8, bytes: 256 }],
    }),
  };

  const prevDoc = (globalThis as { document?: unknown }).document;
  const prevStyle = (globalThis as { HTMLStyleElement?: unknown }).HTMLStyleElement;
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { document?: unknown }).document = document;
  (globalThis as { HTMLStyleElement?: unknown }).HTMLStyleElement = ElementClass;
  (globalThis as { window?: unknown }).window = document.defaultView;
  try {
    const diagView = mountRequestDiagnosticsView(document, diagHost, () => diagBridge as never, () => 'en');
    await diagView.load();
    const summaryText = diagHost.querySelector('.oc-k8s-diagnostics-summary')?.textContent ?? '';
    assert.match(summaryText, /concurrency=2/);
    assert.match(summaryText, /logicalIntents=3/);
    assert.match(summaryText, /coalesced=1/);
    assert.equal(summaryText.includes('Bearer'), false);
    helmView.dispose();
    diagView.dispose();
  } finally {
    if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = prevDoc;
    if (prevStyle === undefined) delete (globalThis as { HTMLStyleElement?: unknown }).HTMLStyleElement;
    else (globalThis as { HTMLStyleElement?: unknown }).HTMLStyleElement = prevStyle;
    if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prevWindow;
  }
});
