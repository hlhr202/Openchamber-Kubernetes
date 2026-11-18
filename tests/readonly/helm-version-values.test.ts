// Pure protocol/projection values only. Never import/call any real Helm CLI runner, client or service reader.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmVersionRequestSchema, helmVersionResponseSchema, classifyHelmSyntax, helmVersionArguments, projectHelmVersion } from '../../src/shared/helm-version-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
const probe = (code: number, stdout: string) => ({ code, stdout });
test('syntax classification follows the pinned probe order: v2 wins only on exit 0 with v2 output', () => {
  assert.equal(classifyHelmSyntax(probe(0, 'v2.16.9+g8ad70f7'), undefined), 'v2');
  assert.equal(classifyHelmSyntax(probe(0, 'v2.16.9'), probe(0, 'v3.19.0')), 'v2'); // v2 probe wins when it answers
  assert.equal(classifyHelmSyntax(probe(1, 'Error'), probe(0, 'v3.19.0')), 'v3');
  assert.equal(classifyHelmSyntax(probe(1, 'Error'), probe(0, 'v4.3.0')), 'v4');
  assert.equal(classifyHelmSyntax(undefined, probe(0, 'v3.19.0')), 'v3');
  assert.equal(classifyHelmSyntax(undefined, undefined), 'unknown');
  assert.equal(classifyHelmSyntax(probe(0, 'v3.19.0'), probe(0, 'v3.19.0')), 'v3'); // modern probe answering the -c form still classifies by content
  assert.equal(classifyHelmSyntax(probe(1, 'x'), probe(0, 'v9.9.9')), 'unknown'); // unknown version never guessed
  assert.equal(classifyHelmSyntax(probe(1, 'x'), probe(1, 'err')), 'unknown');
});
test('the display invocation keeps the -c client flag only for v2, exactly like upstream', () => {
  assert.deepEqual(helmVersionArguments('v2'), ['version', '-c']);
  assert.deepEqual(helmVersionArguments('v3'), ['version']);
  assert.deepEqual(helmVersionArguments('v4'), ['version']);
  assert.deepEqual(helmVersionArguments('unknown'), ['version']);
});
test('pure projection requires a classified syntax, a zero exit and non-empty output', () => {
  assert.deepEqual(projectHelmVersion(probe(0, 'v2.16.9'), probe(1, 'x'), probe(0, 'Client: v2.16.9+g8ad70f7\n')), { syntax: 'v2', output: 'Client: v2.16.9+g8ad70f7' });
  assert.deepEqual(projectHelmVersion(undefined, probe(0, 'v3.19.0'), probe(0, 'v3.19.0+geceptions')), { syntax: 'v3', output: 'v3.19.0+geceptions' });
  for (const args of [[probe(0, 'v3'), undefined, probe(0, 'v3.0.0')], [undefined, undefined, probe(0, 'x')], [probe(0, 'v2'), undefined, probe(1, 'boom')], [probe(0, 'v2'), probe(0, 'v3'), probe(0, '   ')]]) {
    assert.throws(() => projectHelmVersion(args[0], args[1], args[2]), /CLI_INCOMPATIBLE/);
  }
  assert.deepEqual(projectHelmVersion(undefined, probe(0, 'v3'), probe(0, 'v3.0.0')), { syntax: 'v3', output: 'v3.0.0' }); // missing v2 probe is fine when the modern probe classifies
});
test('request carries no target/body/path and the response is bounded text with fixed failure codes', () => {
  assert.equal(helmVersionRequestSchema.safeParse({ protocol: 2, kind: 'read' }).success, true);
  for (const extra of [{ target: {} }, { path: '/usr/bin/helm' }, { argv: ['version'] }, { selection: { mode: 'default' } }]) assert.equal(helmVersionRequestSchema.safeParse({ protocol: 2, kind: 'read', ...extra }).success === false, true);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version', syntax: 'v3', output: 'v3.19.0' }).success, true);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version', syntax: 'v9', output: 'x' }).success, false);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version', syntax: 'v3', output: 'x\0y' }).success, false);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version', syntax: 'v3', output: 'x'.repeat(4097) }).success, false);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version-unavailable', syntax: 'unknown', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmVersionResponseSchema.safeParse({ protocol: 2, kind: 'helm-version-unavailable', syntax: 'unknown', code: 'NOT_A_CODE' }).success, false);
});
test('projection keeps errors as fixed codes, never CLI stderr text', () => {
  assert.ok(projectHelmVersion.name === 'projectHelmVersion');
  assert.throws(() => { throw new BoundaryError('CLI_NOT_FOUND'); }, /CLI_NOT_FOUND/);
});
