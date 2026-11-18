// M2-F13 bootstrap test control plane server: the isolated development container's own
// Kubernetes test API. Plain loopback HTTP (see store.ts for the disclosed TLS deviation).
// REST list/get/post/patch/delete with limit/continue + monotonic resourceVersion, discovery,
// chunked WATCH streams, kubelet /log, and REAL v5/v4.channel.k8s.io WebSocket /exec +
// /portforward endpoints (RFC 6455 server side via the shared pure codec). No plugin business
// imports; no privileges; never run on the development host.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ObjectStore, installFixtures, defaultFixtures, listPage, kubeconfig, mergeJson } from '../../src/shared/bootstrap-store.ts';
import { encodeServerFrame, decodeClientFrames, channelFrame, execChannels } from '../../src/shared/k8s-websocket-protocol.ts';

const port = Number(process.env.BOOTSTRAP_PORT ?? 8443);
const token = randomBytes(24).toString('hex');
const store = new ObjectStore();
installFixtures(store, defaultFixtures());
const secret = randomBytes(32);
const seal = (count: number) => `${count}.${createHash('sha256').update(`${count}:${secret}`).digest('hex').slice(0, 16)}`;
const unseal = (value: string | undefined): number => {
  if (!value) return 0;
  const [count, mac] = value.split('.');
  if (!count || !mac || seal(Number(count)) !== value) return -1;
  return Number(count);
};
const json = (response: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(text);
};
const authorized = (request: IncomingMessage) => request.headers.authorization === `Bearer ${token}`;
const resourceList = (resource: string, namespaced: boolean) => ({ name: resource, namespaced, kind: kindOf(resource), verbs: ['get', 'list', 'watch', 'create', 'patch', 'delete'] });
const kinds: Readonly<Record<string, string>> = { pods: 'Pod', namespaces: 'Namespace', configmaps: 'ConfigMap', secrets: 'Secret', deployments: 'Deployment', services: 'Service' };
function kindOf(resource: string): string { return kinds[resource] ?? resource; }
const apiVersionOf = (resource: string) => ['pods', 'namespaces', 'configmaps', 'secrets', 'services'].includes(resource) ? 'v1' : 'apps/v1';

const watchers = new Set<(event: string, object: unknown) => void>();
function emit(event: string, object: unknown): void { for (const watcher of watchers) watcher(event, object); }

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!authorized(request)) { json(response, 401, { kind: 'Status', status: 'Failure', reason: 'Unauthorized' }); return; }
    if (request.method === 'GET' && url.pathname === '/api') { json(response, 200, { kind: 'APIVersions', versions: ['v1'] }); return; }
    if (request.method === 'GET' && url.pathname === '/api/v1') { json(response, 200, { kind: 'APIResourceList', groupVersion: 'v1', resources: ['pods', 'namespaces', 'configmaps', 'secrets', 'services'].map(resource => resourceList(resource, resource !== 'namespaces')) }); return; }
    if (request.method === 'GET' && url.pathname === '/apis') { json(response, 200, { kind: 'APIGroupList', groups: [{ name: 'apps', versions: [{ groupVersion: 'apps/v1', version: 'v1' }] }] }); return; }
    if (request.method === 'GET' && url.pathname === '/apis/apps/v1') { json(response, 200, { kind: 'APIResourceList', groupVersion: 'apps/v1', resources: [resourceList('deployments', true)] }); return; }
    // /api/v1[/namespaces/{ns}]/{resource}[/{name}] plus /log on pods
    const apps = parts[0] === 'apis' && parts[1] === 'apps' && parts[2] === 'v1';
    const resource = apps ? parts[3] : parts[0] === 'api' && parts[1] === 'v1' ? parts[2] === 'namespaces' && parts.length > 3 && !kinds[parts[3] ?? ''] ? parts[3] : parts[2] : undefined;
    if (!resource) { json(response, 404, { kind: 'Status', status: 'Failure', reason: 'NotFound' }); return; }
    const namespaced = !apps && parts[2] === 'namespaces' && parts.length >= 5;
    const namespace = namespaced ? parts[3] : undefined;
    const nameIndex = namespaced ? 4 : (apps ? 4 : 3);
    const name = parts[nameIndex];
    if (request.method === 'GET' && url.searchParams.get('watch') === 'true') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-store' });
      const watcher = (event: string, object: unknown) => { response.write(`${JSON.stringify({ type: event, object })}\n`); };
      watchers.add(watcher);
      response.once('close', () => watchers.delete(watcher));
      return; // chunked stream stays open until the client disconnects
    }
    if (name && parts[nameIndex + 1] === 'log') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`synthetic log line for ${namespace}/${name}\n`);
      return;
    }
    if (request.method === 'GET' && !name) {
      const items = store.list(resource, namespace);
      const continueCount = unseal(url.searchParams.get('continue') ?? undefined);
      if (continueCount < 0) { json(response, 400, { kind: 'Status', reason: 'BadRequest' }); return; }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 100);
      const page = listPage(items, limit, continueCount);
      const list = { apiVersion: apiVersionOf(resource), kind: `${kindOf(resource)}List`, metadata: { resourceVersion: store.nextVersion(), ...(page.continueCount ? { continue: seal(page.continueCount) } : {}) }, items: page.items };
      json(response, 200, list); return;
    }
    if (request.method === 'GET' && name) {
      const object = store.get(resource, namespace ? `${namespace}/${name}` : name) ?? store.get(resource, name);
      if (!object || namespace && object.metadata.namespace !== namespace) { json(response, 404, { kind: 'Status', status: 'Failure', reason: 'NotFound' }); return; }
      json(response, 200, object); return;
    }
    if (request.method === 'POST' && !name) {
      const body = JSON.parse(await bodyText(request)) as { metadata?: { name?: string; namespace?: string | undefined } };
      if (!body.metadata?.name) { json(response, 400, { kind: 'Status', reason: 'BadRequest' }); return; }
      const object = { ...body, apiVersion: apiVersionOf(resource), kind: kindOf(resource), metadata: { name: body.metadata.name, namespace: namespace ?? body.metadata?.namespace ?? 'default' } };
      const key = namespace ? `${namespace}/${object.metadata.name}` : object.metadata.name;
      if (store.get(resource, key)) { json(response, 409, { kind: 'Status', reason: 'AlreadyExists' }); return; }
      const created = store.insert(resource, object as never);
      emit('ADDED', created); json(response, 201, created); return;
    }
    if (request.method === 'PATCH' && name) {
      const key = namespace ? `${namespace}/${name}` : name;
      const patch = JSON.parse(await bodyText(request)) as Record<string, unknown>;
      const patched = store.patch(resource, key, mergeJson({}, patch) as Record<string, unknown>);
      if (!patched) { json(response, 404, { kind: 'Status', reason: 'NotFound' }); return; }
      emit('MODIFIED', patched); json(response, 200, patched); return;
    }
    if (request.method === 'DELETE' && name) {
      const key = namespace ? `${namespace}/${name}` : name;
      const removed = store.remove(resource, key);
      if (!removed) { json(response, 404, { kind: 'Status', reason: 'NotFound' }); return; }
      emit('DELETED', { apiVersion: apiVersionOf(resource), kind: kindOf(resource), metadata: { name, namespace: namespace ?? 'default' } });
      json(response, 200, { kind: 'Status', status: 'Success' }); return;
    }
    json(response, 405, { kind: 'Status', reason: 'MethodNotAllowed' });
  })().catch(() => { try { json(response, 500, { kind: 'Status', reason: 'InternalError' }); } catch { /* already gone */ } });
});
function bodyText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { let text = ''; request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); if (text.length > 1_048_576) reject(new Error('too large')); }); request.once('end', () => resolve(text)); request.once('error', reject); });
}
// ---- RFC 6455 upgrade: /exec and /portforward speak the K8s channel protocol ----
server.on('upgrade', (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
  const key = request.headers['sec-websocket-key'];
  const protocol = String(request.headers['sec-websocket-protocol'] ?? '');
  if (!key || !protocol.includes('v5.channel.k8s.io') && !protocol.includes('v4.channel.k8s.io')) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol.split(',')[0]?.trim()}\r\n\r\n`);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const isPortforward = url.pathname.endsWith('/portforward');
  const send = (payload: Uint8Array) => { if (!socket.destroyed) socket.write(Buffer.from(encodeServerFrame({ fin: true, opcode: 2, payload }))); };
  if (head.length) { /* no buffered pre-upgrade bytes expected */ }
  socket.on('data', (chunk: Buffer) => {
    try {
      const decoded = decodeClientFrames(Uint8Array.from(chunk));
      for (const frame of decoded.frames) {
        if (frame.opcode !== 2) continue;
        const channel = frame.payload[0] ?? 0, payload = frame.payload.subarray(1);
        if (!isPortforward && channel === execChannels.stdin) {
          // The synthetic container echoes stdin bytes back on stdout (tty-style) so terminal
          // round-trips are observable without a real container runtime.
          send(channelFrame(execChannels.stdout, payload));
        }
      }
    } catch { socket.destroy(); }
  });
  socket.once('close', () => { /* session over; no cleanup hooks */ });
});
const output = process.env.BOOTSTRAP_OUTPUT ?? '.build/bootstrap';
mkdirSync(dirname(join(output, 'kubeconfig')), { recursive: true });
const stream = createWriteStream(join(output, 'kubeconfig'), { mode: 0o600 });
stream.end(kubeconfig(`http://127.0.0.1:${port}`, token));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`bootstrap control plane listening on 127.0.0.1:${port}; synthetic kubeconfig at ${join(output, 'kubeconfig')}\n`);
});
