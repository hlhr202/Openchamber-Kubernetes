// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PORT_COUNT, isPortValid, validatePortPair, validatePortMapping, hasDuplicateLocalPorts, buildPortMapping, portForwardRequestSchema, portForwardResponseSchema } from '../../src/shared/port-forward-protocol.ts';
const named = [{ name: 'http', port: 8080 }, { name: 'metrics', port: 9090 }];
test('the request takes a bounded pod/namespace and raw port-mapping text', () => {
  assert.equal(portForwardRequestSchema.safeParse({ protocol: 2, kind: 'run', pod: 'my-pod', namespace: 'default', ports: '8888:5000 5000' }).success, true);
  for (const bad of [{ pod: '', namespace: 'default', ports: '5000' }, { pod: 'p', namespace: 'Bad Ns', ports: '5000' }, { pod: 'p', namespace: 'default', ports: '' }, { pod: 'p', namespace: 'default', ports: 'x'.repeat(513) }, { pod: 'p', namespace: 'default', ports: '5000', extra: 1 }]) assert.equal(portForwardRequestSchema.safeParse({ protocol: 2, kind: 'run', ...bad }).success === false, true, JSON.stringify(bad));
});
test('port validity is upstream verbatim: named resolution, empty/zero rules, 1..65535 range', () => {
  assert.equal(isPortValid(named, 'http', 0), true);
  assert.equal(isPortValid(named, '8080', 0), true);
  assert.equal(isPortValid(named, '0', 1), true); // AllowEmpty accepts zero (Server auto-port)
  assert.equal(isPortValid(named, '0', 0), false);
  assert.equal(isPortValid(named, '65535', 0), true);
  assert.equal(isPortValid(named, '65536', 0), false);
  assert.equal(isPortValid(named, 'abc', 0), false); // NaN fails the numeric range
  assert.equal(MAX_PORT_COUNT, 65535);
});
test('pair validation keeps the upstream shapes and exact error strings', () => {
  assert.deepEqual(validatePortPair(named, '5000'), { valid: true }); // REMOTE only
  assert.deepEqual(validatePortPair(named, '8888:5000'), { valid: true }); // LOCAL:REMOTE
  assert.deepEqual(validatePortPair(named, ':5000'), { valid: true }); // :REMOTE (empty local)
  assert.deepEqual(validatePortPair(named, '0:5000'), { valid: true }); // 0:REMOTE auto-port
  assert.deepEqual(validatePortPair(named, 'http'), { valid: true }); // named target
  assert.deepEqual(validatePortPair(named, 'a:b:c'), { valid: false, error: 'Invalid port mapping: a:b:c' });
  assert.deepEqual(validatePortPair(named, '70000:5000'), { valid: false, error: 'Invalid ports. Please enter a valid port mapping ie: 8888:5000 or 5000. Valid port range:  1 – 65535' });
  assert.equal(validatePortMapping('8888:5000 5000'), undefined);
  assert.deepEqual(validatePortMapping('8888:5000 bad'), { valid: false, error: 'Invalid ports. Please enter a valid port mapping ie: 8888:5000 or 5000. Valid port range:  1 – 65535' });
});
test('duplicate explicit local ports are rejected (disclosed hardening) and building is verbatim', () => {
  assert.equal(hasDuplicateLocalPorts('8888:5000 8888:6000'), true);
  assert.equal(hasDuplicateLocalPorts('8888:5000 8889:6000'), false);
  assert.equal(hasDuplicateLocalPorts(':5000 0:6000 5000'), false); // auto/empty locals never collide
  assert.deepEqual(buildPortMapping('8888:5000 5000', named), [{ localPort: 8888, targetPort: 5000 }, { localPort: undefined, targetPort: 5000 }]);
  assert.deepEqual(buildPortMapping(':9090 0:http', named), [{ localPort: undefined, targetPort: 9090 }, { localPort: undefined, targetPort: 8080 }]); // named resolution
  assert.deepEqual(buildPortMapping('http', named), [{ localPort: undefined, targetPort: 8080 }]);
  assert.equal(portForwardResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-validated', mappings: [{ localPort: 8888, targetPort: 5000 }] }).success, true);
  assert.equal(portForwardResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-validated', mappings: [{ localPort: 0, targetPort: 5000 }] }).success, false);
  assert.equal(portForwardResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(portForwardResponseSchema.safeParse({ protocol: 2, kind: 'port-forward-unavailable', code: 'NOPE' }).success, false);
});
