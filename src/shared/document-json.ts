import { BoundaryError } from './errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from './identity.ts';

// JSON token tree, not JS numeric values: int64, exponent, decimal and -0 survive without rounding.
export type JsonToken = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'atom'; readonly text: string }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, JsonToken])[] } | { readonly kind: 'array'; readonly items: readonly JsonToken[] };
export function parseDocumentJson(text: string): JsonToken {
  if (utf8ByteLength(text) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  let position = 0, nodes = 0;
  const fail = (): never => { throw new BoundaryError('CONTENT_INVALID'); };
  const white = () => { while ([' ', '\t', '\r', '\n'].includes(text[position] ?? 'missing')) position++; };
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function string(): string {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') { position++; continue; }
      if (character === '"') {
        let value: unknown;
        try { value = JSON.parse(text.slice(start, position)) as unknown; } catch { return fail(); }
        if (typeof value !== 'string' || !hasWellFormedUnicode(value)) return fail();
        return value;
      }
    }
    return fail();
  }
  function value(depth: number): JsonToken {
    if (depth > 64 || ++nodes > 50_000) throw new BoundaryError('BUDGET_EXCEEDED');
    white(); const character = text[position];
    if (character === '"') return { kind: 'string', value: string() };
    if (character === '{') {
      position++; white(); const entries: [string, JsonToken][] = [], keys = new Set<string>();
      if (text[position] === '}') { position++; return { kind: 'object', entries }; }
      while (position < text.length) {
        white(); if (text[position] !== '"') return fail();
        const key = string(); if (keys.has(key)) return fail(); keys.add(key);
        white(); if (text[position++] !== ':') return fail();
        entries.push([key, value(depth + 1)]); white();
        const separator = text[position++]; if (separator === '}') return { kind: 'object', entries };
        if (separator !== ',') return fail();
      }
      return fail();
    }
    if (character === '[') {
      position++; white(); const items: JsonToken[] = [];
      if (text[position] === ']') { position++; return { kind: 'array', items }; }
      while (position < text.length) {
        items.push(value(depth + 1)); white();
        const separator = text[position++]; if (separator === ']') return { kind: 'array', items };
        if (separator !== ',') return fail();
      }
      return fail();
    }
    for (const token of ['true', 'false', 'null']) if (text.startsWith(token, position)) { position += token.length; return { kind: 'atom', text: token }; }
    number.lastIndex = position; const parsed = number.exec(text);
    if (!parsed) return fail();
    position = number.lastIndex; return { kind: 'atom', text: parsed[0] };
  }
  const result = value(0); white(); if (position !== text.length) return fail(); return result;
}

export function documentProperty(node: JsonToken | undefined, key: string): JsonToken | undefined { return node?.kind === 'object' ? node.entries.find(entry => entry[0] === key)?.[1] : undefined; }
export function documentString(node: JsonToken | undefined): string | undefined { return node?.kind === 'string' ? node.value : undefined; }

// Block YAML 1.2 uses JSON-quoted keys/strings, never implicit tags or aliases. Not an editor YAML parser.
export function renderDocumentJson(node: JsonToken, format: 'json' | 'yaml', maximumBytes: number): string {
  const chunks: string[] = []; let bytes = 0;
  function emit(text: string) { bytes += utf8ByteLength(text); if (bytes > maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED'); chunks.push(text); }
  function inline(node: JsonToken): string | null {
    if (node.kind === 'atom') return node.text;
    if (node.kind === 'string') return JSON.stringify(node.value);
    if (node.kind === 'array' && !node.items.length) return '[]';
    if (node.kind === 'object' && !node.entries.length) return '{}';
    return null;
  }
  function render(node: JsonToken, depth: number) {
    if (depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
    const scalar = inline(node), indent = '  '.repeat(depth);
    if (scalar !== null) { emit(scalar); return; }
    const entries = node.kind === 'object' ? node.entries : node.kind === 'array' ? node.items.map(value => [null, value] as const) : [];
    if (format === 'json') emit(node.kind === 'object' ? '{\n' : '[\n');
    entries.forEach(([key, value], index) => {
      if (format === 'json') {
        emit('  '.repeat(depth + 1)); if (key !== null) emit(`${JSON.stringify(key)}: `); render(value, depth + 1); emit(index < entries.length - 1 ? ',\n' : '\n');
      } else {
        emit(indent + (key === null ? '-' : `${JSON.stringify(key)}:`));
        const scalar = inline(value);
        if (scalar === null) { emit('\n'); render(value, depth + 1); }
        else emit(` ${scalar}\n`);
      }
    });
    if (format === 'json') emit(indent + (node.kind === 'object' ? '}' : ']'));
  }
  render(node, 0); if (format === 'json' || inline(node) !== null) emit('\n'); return chunks.join('');
}
