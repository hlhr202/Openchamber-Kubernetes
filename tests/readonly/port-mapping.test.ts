// Synthetic scalar parameters only. No session/confirmation/planner/writer/CLI/SDK, allocation or networking.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePortMappings, portMappingLimits } from '../../src/shared/port-mapping.ts';

test('explicit numeric pairs preserve mapping order and uint16 endpoints', () => {
  assert.deepEqual(parsePortMappings('8888:5000 1:65535'), [{ localPort: 8888, targetPort: 5000 }, { localPort: 1, targetPort: 65535 }]);
});
test('target-only, empty local and local zero mean automatic allocation, never a ready listening port', () => {
  assert.deepEqual(parsePortMappings('80 :81 0:82'), [80, 81, 82].map(targetPort => ({ localPort: null, targetPort })));
});
test('known named ports resolve on either side as in the pinned upstream grammar', () => {
  const names = [{ name: 'http', port: 80 }, { name: 'metrics', port: 9090 }];
  assert.deepEqual(parsePortMappings('metrics:http http :http 0:metrics', names), [{ localPort: 9090, targetPort: 80 }, { localPort: null, targetPort: 80 }, { localPort: null, targetPort: 80 }, { localPort: null, targetPort: 9090 }]);
});
test('generated fallback names and repeated identical suggestion names stay unambiguous', () => {
  assert.deepEqual(parsePortMappings('8000:port-80', [{ name: 'port-80', port: 80 }, { name: 'port-80', port: 80 }]), [{ localPort: 8000, targetPort: 80 }]);
});
test('a duplicate name with different ports rejects all suggestions, not first-match target guessing', () => {
  assert.throws(() => parsePortMappings('80', [{ name: 'http', port: 80 }, { name: 'http', port: 8080 }]), /CONTENT_INVALID/);
});
test('decimal leading zeros normalize without accepting hex, exponent, sign, fractions or numeric suffixes', () => {
  assert.deepEqual(parsePortMappings('00080:00081'), [{ localPort: 80, targetPort: 81 }]);
  for (const value of ['+80', '-80', '0x50', '1e2', '1.5', '80x', 'Infinity', 'NaN', '000080', '80:1e2', '1.5:80']) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('zero/empty/overflow targets and overflow local ports fail fixed', () => {
  for (const value of ['0', ':0', '80:0', '80:', ':', '65536', '65536:80', '80:65536', '00:80']) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('unknown names and extra colon/address grammar are not passed through to a CLI', () => {
  for (const value of ['http', '80:http', '::80', '1:2:3', '127.0.0.1:80:80', '[::1]:80:80', '--address=0.0.0.0']) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('empty and non-string inputs are not cancellation or an implicit default forward', () => {
  for (const value of ['', '   ', null, undefined, 80, {}, []]) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('ASCII spaces can wrap/separate pairs; controls and Unicode whitespace remain invalid', () => {
  assert.deepEqual(parsePortMappings('  80   81  '), [{ localPort: null, targetPort: 80 }, { localPort: null, targetPort: 81 }]);
  for (const value of ['80\n81', '80\t81', '80\r', '80\u0000', '80\u001b[0m', '80\u00a081', '８０', '80\u202e']) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('shell operators, substitutions, redirects and quoting never become valid port expressions', () => {
  for (const value of ['80;id', '80 && id', '$(id)', '`id`', '80|cat', '80 > file', '"80"', "'80'", '80 &']) assert.throws(() => parsePortMappings(value), /INVALID_INPUT/);
});
test('explicit local collisions reject even through aliases/leading zeros; automatic pairs are not reserved', () => {
  for (const value of ['80:81 80:82', '00080:81 80:82', 'http:81 80:82']) assert.throws(() => parsePortMappings(value, [{ name: 'http', port: 80 }]), /INVALID_INPUT/);
  assert.equal(parsePortMappings('80 80 :80 0:80').length, 4);
});
test('input and mapping count budgets fail whole without truncation', () => {
  assert.equal(parsePortMappings(Array(16).fill('80').join(' ')).length, portMappingLimits.mappings);
  assert.throws(() => parsePortMappings(Array(17).fill('80').join(' ')), /BUDGET_EXCEEDED/);
  assert.throws(() => parsePortMappings(' '.repeat(portMappingLimits.characters + 1)), /BUDGET_EXCEEDED/);
});
test('suggestion budgets/schema reject unknown fields, unsafe names, nonintegers and objects', () => {
  for (const value of [[{ name: 'http', port: 80, text: 'SYNTHETIC_PRIVATE' }], [{ name: 'HTTP', port: 80 }], [{ name: 'x;id', port: 80 }], [{ name: 'x', port: 0 }], [{ name: 'x', port: 65536 }], [{ name: 'x', port: 1.5 }], [{ name: 'x', port: '80' }], {}, null]) assert.throws(() => parsePortMappings('80', value), /CONTENT_INVALID/);
  assert.throws(() => parsePortMappings('80', Array(257).fill({ name: 'http', port: 80 })), /BUDGET_EXCEEDED/);
  assert.equal(parsePortMappings('http', Array(256).fill({ name: 'http', port: 80 })).length, 1);
});
test('result and records are detached/frozen and disclose only numeric mappings', () => {
  const suggestions = [{ name: 'http', port: 80 }], result = parsePortMappings('http', suggestions), firstSuggestion = suggestions[0], firstResult = result[0]; assert.ok(firstSuggestion && firstResult); firstSuggestion.port = 81;
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen)); assert.deepEqual(result, [{ localPort: null, targetPort: 80 }]); assert.deepEqual(Object.keys(firstResult).sort(), ['localPort', 'targetPort']);
});
test('validation errors never echo input or suggestion content', () => {
  for (const operation of [() => parsePortMappings('SYNTHETIC_PRIVATE;id'), () => parsePortMappings('80', [{ name: 'http', port: 80, secret: 'SYNTHETIC_PRIVATE' }])]) {
    try { operation(); assert.fail('expected rejection'); } catch (error) { assert.ok(error instanceof Error); assert.ok(!error.message.includes('SYNTHETIC_PRIVATE')); }
  }
});
