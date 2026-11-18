// Pure portable helpers of the M2-F13 bootstrap test control plane: monotonic store,
// RFC 7386 merge patch, pagination, idempotent synthetic fixtures and the synthetic kubeconfig.
// Product code never imports this (tree-shaken from both bundles); the server in
// scripts/bootstrap-cluster and the read-only suites are the only consumers.
export type BootstrapObject = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string | undefined; uid: string; resourceVersion: string; creationTimestamp: string; labels?: Record<string, string> | undefined }; spec?: unknown; data?: Record<string, string>; status?: unknown };
export type Fixture = { readonly namespace: string; readonly object: Omit<BootstrapObject, 'metadata'> & { metadata: { name: string; namespace?: string | undefined; uid?: string | undefined; resourceVersion?: string | undefined; creationTimestamp?: string | undefined; labels?: Record<string, string> | undefined } } };

// Monotonic in-memory store: uid + strictly increasing resourceVersion per mutation.
export class ObjectStore {
  #version = 1000;
  readonly #objects = new Map<string, Map<string, BootstrapObject>>();
  nextVersion(): string { return String(++this.#version); }
  collection(key: string): Map<string, BootstrapObject> { const existing = this.#objects.get(key); if (existing) return existing; const created = new Map(); this.#objects.set(key, created); return created; }
  insert(key: string, object: BootstrapObject): BootstrapObject {
    const stored: BootstrapObject = { ...object, metadata: { ...object.metadata, uid: object.metadata.uid || cryptoRandomId(), resourceVersion: this.nextVersion(), creationTimestamp: object.metadata.creationTimestamp || new Date().toISOString() } };
    this.collection(key).set(stored.metadata.name, stored); return stored;
  }
  get(key: string, name: string): BootstrapObject | undefined { return this.collection(key).get(name); }
  list(key: string, namespace?: string): readonly BootstrapObject[] {
    const all = [...this.collection(key).values()];
    return namespace === undefined ? all : all.filter(object => object.metadata.namespace === namespace);
  }
  patch(key: string, name: string, patch: Record<string, unknown>): BootstrapObject | undefined {
    const current = this.get(key, name); if (!current) return undefined;
    const next = mergeJson(current, patch) as BootstrapObject;
    next.metadata.resourceVersion = this.nextVersion();
    this.collection(key).set(name, next); return next;
  }
  remove(key: string, name: string): boolean { return this.collection(key).delete(name); }
}
function cryptoRandomId(): string {
  const crypto = (globalThis as { readonly crypto?: { readonly randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `uid-${Math.random().toString(16).slice(2)}`;
}
// Pure RFC 7386 JSON merge patch.
export function mergeJson(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const source = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete source[key];
    else source[key] = mergeJson(source[key], value);
  }
  return source;
}
// limit/continue pagination over a stable snapshot: continue encodes the consumed count in a
// tamper-evident base64 token (server secret hashing lives in server.ts).
export function listPage<T>(items: readonly T[], limit: number, continueCount: number): { readonly items: readonly T[]; readonly continueCount: number } {
  const page = items.slice(continueCount, continueCount + limit);
  const next = continueCount + page.length;
  return { items: page, continueCount: next < items.length ? next : 0 };
}
// Idempotent synthetic fixtures (no real data, no credentials).
export function installFixtures(store: ObjectStore, fixtures: readonly Fixture[]): void {
  store.insert('namespaces', namespaceObject('default'));
  store.insert('namespaces', namespaceObject('kube-system'));
  for (const fixture of fixtures) {
    const object = { ...fixture.object, apiVersion: fixture.object.apiVersion, kind: fixture.object.kind,
      metadata: { name: fixture.object.metadata.name, namespace: fixture.namespace, uid: fixture.object.metadata.uid ?? '', resourceVersion: fixture.object.metadata.resourceVersion ?? '', creationTimestamp: fixture.object.metadata.creationTimestamp ?? '', ...(fixture.object.metadata.labels ? { labels: fixture.object.metadata.labels } : {}) } } as BootstrapObject;
    store.insert(resourceOf(object.kind), object);
  }
}
function resourceOf(kind: string): string { return kind === 'Namespace' ? 'namespaces' : `${kind.toLowerCase()}s`; }
function namespaceObject(name: string): BootstrapObject {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name, uid: cryptoRandomId(), resourceVersion: '1', creationTimestamp: new Date().toISOString() } };
}
export function defaultFixtures(): readonly Fixture[] {
  return [
    { namespace: 'default', object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'synthetic-web', labels: { app: 'synthetic-web' } },
      spec: { replicas: 1, selector: { matchLabels: { app: 'synthetic-web' } }, template: { metadata: { labels: { app: 'synthetic-web' } }, spec: { containers: [{ name: 'web', image: 'synthetic-web:1' }] } } } } },
    { namespace: 'default', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'synthetic-web-abcde', labels: { app: 'synthetic-web' } },
      spec: { containers: [{ name: 'web', image: 'synthetic-web:1' }] }, status: { phase: 'Running' } } },
    { namespace: 'default', object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'synthetic-settings' }, data: { key: 'value' } } },
  ];
}
// Synthetic kubeconfig pointing at the loopback plain-HTTP endpoint (no CA, synthetic token).
export function kubeconfig(server: string, token: string): string {
  return `${JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'bootstrap',
    clusters: [{ name: 'bootstrap', cluster: { server } }],
    users: [{ name: 'bootstrap', user: { token } }], contexts: [{ name: 'bootstrap', context: { cluster: 'bootstrap', user: 'bootstrap', namespace: 'default' } }] }, null, 2)}\n`;
}
