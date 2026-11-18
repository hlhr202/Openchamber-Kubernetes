// Text/metadata only. The bootstrap control plane must stay isolated: no plugin business
// imports, no privileged compose keys, no host mounts; the store helpers are covered in readonly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the bootstrap control plane never imports plugin business code (M2-C11)', async () => {
  for (const name of ['src/shared/bootstrap-store.ts', 'scripts/bootstrap-cluster/server.ts']) {
    const code = await file(name);
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(match => match[1]!);
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        assert.ok(!/service\/(operations|sessions|runtime|adapters|queries)/.test(specifier), `${name}: ${specifier}`);
        assert.ok(!specifier.includes('panel') && !specifier.includes('host/') && !specifier.includes('service'), `${name}: ${specifier}`);
      }
    }
  }
  const server = await file('scripts/bootstrap-cluster/server.ts');
  assert.ok(server.includes("from '../../src/shared/k8s-websocket-protocol.ts'")); // shared PURE modules are the only plugin imports
  assert.ok(server.includes("from '../../src/shared/bootstrap-store.ts'"));
});
test('the server speaks the real WebSocket upgrade and the K8s channel protocol', async () => {
  const server = await file('scripts/bootstrap-cluster/server.ts');
  for (const part of ["258EAFA5-E914-47DA-95CA-C5AB0DC85B11", 'Sec-WebSocket-Accept', 'decodeClientFrames', 'encodeServerFrame', 'channelFrame(execChannels.stdout, payload)', "url.pathname.endsWith('/portforward')", "url.searchParams.get('watch') === 'true'", 'Transfer-Encoding', 'resourceVersion']) assert.ok(server.includes(part), part);
  assert.ok(server.includes('loopback plain-HTTP') || server.includes('loopback'));
  assert.ok(!/console\.log|writeFile\(|execFile|spawn\(/.test(server.replace(/createWriteStream/, '')));
});
test('the compose bootstrap profile stays unprivileged with no network and no host mounts', async () => {
  const compose = await file('docker-compose.yml');
  const profile = compose.slice(compose.indexOf('  bootstrap:'), compose.lastIndexOf('networks:'));
  for (const part of ['profiles: [bootstrap]', 'network_mode: none', 'command: [node, --experimental-strip-types, scripts/bootstrap-cluster/server.ts]']) assert.ok(profile.includes(part), part);
  assert.ok(!/privileged|hostnetwork|\/var\/run\/docker\.sock/.test(profile));
});
test('the store helpers are covered by the registered readonly suite', async () => {
  const readonly = await file('tests/readonly/bootstrap-cluster-values.test.ts');
  assert.ok(readonly.includes('ObjectStore') && readonly.includes('mergeJson') && readonly.includes('listPage'));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/bootstrap-cluster-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/bootstrap-cluster-wiring.test.ts'"));
});
