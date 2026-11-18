// Pure DAP frame codec values. No sockets, no bridges.
import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDapFrame, decodeDapFrames, isDapResponseTo, defaultDebugPort, dapLanguages } from '../../src/shared/dap-protocol.ts';
const utf8 = (text: string) => Uint8Array.from(text, character => character.charCodeAt(0));
const frame = (body: string) => utf8(`Content-Length: ${body.length}\r\n\r\n${body}`);
const message = (over: Record<string, unknown> = {}) => ({ seq: 1, type: 'request' as const, command: 'initialize', arguments: { adapterID: 'node' }, ...over });
test('frames encode as the fixed DAP header plus the exact body length', () => {
  const encoded = encodeDapFrame(message());
  const text = new TextDecoder().decode(encoded);
  assert.ok(text.startsWith('Content-Length: '));
  const [header, body] = text.split('\r\n\r\n');
  assert.match(header ?? '', /^Content-Length: \d+$/);
  assert.equal(Number((header ?? '').split(': ')[1]), (body ?? '').length);
  assert.deepEqual(JSON.parse(body ?? '{}').command, 'initialize');
});
test('decoding is incremental across split headers/bodies and rejects malformed frames', () => {
  const whole = frame(JSON.stringify(message()));
  const partial = decodeDapFrames(whole.subarray(0, whole.length - 5));
  assert.equal(partial.messages.length, 0);
  assert.equal(partial.remainder.length, whole.length - 5);
  const split = decodeDapFrames(new Uint8Array([...whole.subarray(0, 12), ...whole.subarray(12)]));
  assert.equal(split.messages.length, 1);
  assert.equal(split.messages[0]?.command, 'initialize');
  const two = decodeDapFrames(new Uint8Array([...frame('{"seq":1,"type":"event","command":"stopped"}'), ...frame('{"seq":2,"type":"response","command":"stackTrace","request_seq":5,"success":true}')]));
  assert.equal(two.messages.length, 2);
  assert.equal(two.remainder.length, 0);
  for (const bad of [
    utf8('Content-Type: text\r\n\r\n{}'), // unknown header
    utf8('Content-Length: abc\r\n\r\n{}'), // malformed length
    frame('not json'), // malformed body
    frame('{"seq":1.5,"type":"request","command":"x"}'), // fractional seq
    frame('{"seq":1,"type":"wire","command":"x"}'), // wrong type
    frame('{"seq":1,"type":"request"}'), // missing command
  ]) assert.throws(() => decodeDapFrames(bad), /CONTENT_INVALID/);
});
test('response correlation and language port defaults stay pinned', () => {
  const response = { seq: 2, type: 'response' as const, command: 'initialize', request_seq: 1, success: true };
  assert.equal(isDapResponseTo(response, 1), true);
  assert.equal(isDapResponseTo(response, 2), false);
  assert.equal(isDapResponseTo({ seq: 3, type: 'event' as const, command: 'stopped' }, 1), false);
  assert.deepEqual([...dapLanguages], ['node', 'python', 'go', 'dotnet', 'java']);
  assert.equal(defaultDebugPort('node'), 9229);
  assert.equal(defaultDebugPort('python'), undefined);
});
