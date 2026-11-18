// Pure JSON value comparison model (RFC 7386 / Kubernetes three-way JSON-merge).
// No lifecycle, authority, IO, transport, executable plan, schema selection or mutation of inputs.
import { BoundaryError } from './errors.ts';
import { parseDocumentJson, renderDocumentJson } from './document-json.ts';
import type { JsonToken } from './document-json.ts';
import { utf8ByteLength } from './identity.ts';
type ObjectToken = Extract<JsonToken, { kind: 'object' }>;
const empty = (): ObjectToken => ({ kind: 'object', entries: [] });
const nil: JsonToken = { kind: 'atom', text: 'null' };
const isNull = (value: JsonToken) => value.kind === 'atom' && value.text === 'null';
export type JsonMergeComparison = { readonly model: 'three-way-json-merge'; readonly equal: boolean; readonly delta: string; readonly result: string };
// Numeric equality uses exact decimal coefficient/exponent, not floating point or gigantic powers.
// Lexemes are preserved in emitted values; equivalent number spellings do not create a false delta.
function atomKey(text: string): string {
  if (['null', 'true', 'false'].includes(text)) return text;
  const parts = text.toLowerCase().split('e'), mantissa = parts[0] ?? '', exponent = parts[1] ?? '0';
  if (exponent.replace(/^[+-]/, '').length > 128) throw new BoundaryError('BUDGET_EXCEEDED');
  const dot = mantissa.indexOf('.'), negative = mantissa.startsWith('-'), digits = mantissa.replace(/^-/, '').replace('.', '').replace(/^0+/, '');
  if (!digits) return '0';
  const coefficient = digits.replace(/0+$/, ''), trailing = digits.length - coefficient.length;
  const scale = BigInt(exponent) - BigInt(dot < 0 ? 0 : mantissa.length - dot - 1) + BigInt(trailing);
  return `${negative ? '-' : ''}${coefficient}e${scale}`;
}
export function compareThreeWayJson(original: string, modified: string, current: string): JsonMergeComparison {
  if ([original, modified, current].some(text => utf8ByteLength(text) > 1_048_576)) throw new BoundaryError('BUDGET_EXCEEDED');
  const inputs = [original, modified, current].map(parseDocumentJson), [before, desired, live] = inputs;
  if (!before || !desired || !live || inputs.some(value => value.kind !== 'object')) throw new BoundaryError('CONTENT_INVALID');
  let work = 0;
  function step(depth: number) { if (depth > 64 || ++work > 200_000) throw new BoundaryError('BUDGET_EXCEEDED'); }
  function equal(left: JsonToken, right: JsonToken, depth: number): boolean {
    step(depth); if (left.kind !== right.kind) return false;
    if (left.kind === 'string' && right.kind === 'string') return left.value === right.value;
    if (left.kind === 'atom' && right.kind === 'atom') return atomKey(left.text) === atomKey(right.text);
    if (left.kind === 'array' && right.kind === 'array') return left.items.length === right.items.length && left.items.every((item, index) => { const peer = right.items[index]; return !!peer && equal(item, peer, depth + 1); });
    if (left.kind === 'object' && right.kind === 'object') {
      if (left.entries.length !== right.entries.length) return false;
      const peers = new Map(right.entries); return left.entries.every(([key, item]) => { const peer = peers.get(key); return !!peer && equal(item, peer, depth + 1); });
    }
    return false;
  }
  // Two-way merge delta. Arrays are atomic values: never strategic lists or index-wise merges.
  function diff(left: JsonToken, right: JsonToken, depth: number): JsonToken | undefined {
    step(depth); if (equal(left, right, depth)) return undefined;
    if (left.kind !== 'object' || right.kind !== 'object') return right;
    const from = new Map(left.entries), to = new Map(right.entries), entries: [string, JsonToken][] = [];
    for (const [key, value] of right.entries) { const previous = from.get(key), delta = previous ? diff(previous, value, depth + 1) : value; if (delta) entries.push([key, delta]); }
    for (const [key] of left.entries) if (!to.has(key)) entries.push([key, nil]);
    return { kind: 'object', entries };
  }
  // Same empty-map and null filtering as apimachinery/jsonmergepatch.keepOrDeleteNullInObj.
  function filter(value: JsonToken, keepNull: boolean, depth: number): ObjectToken {
    step(depth); if (value.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
    const entries: [string, JsonToken][] = [];
    for (const [key, item] of value.entries) {
      if (isNull(item)) { if (keepNull) entries.push([key, item]); }
      else if (item.kind === 'object') {
        if (!item.entries.length) { if (!keepNull) entries.push([key, item]); }
        else { const nested = filter(item, keepNull, depth + 1); if (nested.entries.length) entries.push([key, nested]); }
      } else if (!keepNull) entries.push([key, item]);
    }
    return { kind: 'object', entries };
  }
  function conflicts(left: JsonToken, right: JsonToken, depth: number): boolean {
    step(depth);
    if (left.kind === 'object' && right.kind === 'object') { const peers = new Map(right.entries); return left.entries.some(([key, item]) => { const peer = peers.get(key); return !!peer && conflicts(item, peer, depth + 1); }); }
    return !equal(left, right, depth);
  }
  function merge(target: JsonToken, delta: JsonToken, depth: number): JsonToken {
    step(depth); if (delta.kind !== 'object') return delta;
    const values = new Map(target.kind === 'object' ? target.entries : []);
    for (const [key, value] of delta.entries) { if (isNull(value)) values.delete(key); else values.set(key, merge(values.get(key) ?? nil, value, depth + 1)); }
    return { kind: 'object', entries: [...values.entries()] };
  }
  const additions = filter(diff(live, desired, 0) ?? empty(), false, 0), deletions = filter(diff(before, desired, 0) ?? empty(), true, 0);
  if (conflicts(additions, deletions, 0)) throw new BoundaryError('CONFLICT');
  const delta = merge(deletions, additions, 0), result = merge(live, delta, 0);
  return Object.freeze({ model: 'three-way-json-merge', equal: equal(live, result, 0), delta: renderDocumentJson(delta, 'json', 1_048_576), result: renderDocumentJson(result, 'json', 1_048_576) });
}
