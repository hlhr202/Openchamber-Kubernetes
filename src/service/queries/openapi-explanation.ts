import { createHash } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { explanationSchema } from '../../shared/explain-protocol.ts';
import type { ExplainRequest } from '../../shared/explain-protocol.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('RESOURCE_INVALID');
  return value as Record<string, unknown>;
}
function own(value: Record<string, unknown>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
export function openApiLocation(input: unknown, type: ExplainRequest['type']) {
  const key = type.group ? `apis/${type.group}/${type.version}` : `api/${type.version}`, path = `/openapi/v3/${key}`;
  const paths = object(own(object(input), 'paths')); if (Object.keys(paths).length > 2000) throw new BoundaryError('BUDGET_EXCEEDED');
  const entry = own(paths, key); if (!entry) throw new BoundaryError('NOT_FOUND');
  const url = own(object(entry), 'serverRelativeURL');
  if (typeof url !== 'string' || !url.startsWith(`${path}?hash=`) || !/^[A-Za-z0-9_-]{1,128}$/.test(url.slice(path.length + 6))) throw new BoundaryError('RESOURCE_INVALID');
  return { path, query: { hash: url.slice(path.length + 6) }, identity: createHash('sha256').update(url).digest('hex') };
}
export function projectExplanation(input: unknown, request: Pick<ExplainRequest, 'type' | 'fieldPath'>) {
  // Count/depth before recursive schema traversal; JSON itself is bounded by the transport. No remote refs or evaluation.
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop(); if (!item) break;
    if (++nodes > 200_000 || item.depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
    if (item.value && typeof item.value === 'object') {
      const values = Object.values(item.value); if (pending.length + values.length + nodes > 200_000) throw new BoundaryError('BUDGET_EXCEEDED');
      for (const value of values) pending.push({ value, depth: item.depth + 1 });
    }
  }
  const document = object(input);
  if (typeof document.openapi !== 'string' || !/^3\.0\.\d+$/.test(document.openapi)) throw new BoundaryError('RESOURCE_INVALID');
  const schemas = object(own(object(own(document, 'components')), 'schemas')), entries = Object.values(schemas);
  if (entries.length > 10_000) throw new BoundaryError('BUDGET_EXCEEDED');
  const roots = entries.filter(value => {
    const extension = own(object(value), 'x-kubernetes-group-version-kind');
    return Array.isArray(extension) && extension.some(value => { const gvk = object(value); return gvk.group === request.type.group && gvk.version === request.type.version && gvk.kind === request.type.kind; });
  });
  if (!roots.length) throw new BoundaryError('NOT_FOUND'); if (roots.length !== 1) throw new BoundaryError('RESOURCE_INVALID');
  let steps = 0;
  function resolve(value: unknown, seen = new Set<string>()): Record<string, unknown> {
    if (++steps > 512) throw new BoundaryError('BUDGET_EXCEEDED');
    const node = object(value), ref = own(node, '$ref'), all = own(node, 'allOf');
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !/^#\/components\/schemas\/[A-Za-z0-9_.-]+$/.test(ref) || seen.has(ref)) throw new BoundaryError('RESOURCE_INVALID');
      seen.add(ref); const next = own(schemas, ref.slice('#/components/schemas/'.length)); if (!next) throw new BoundaryError('NOT_FOUND');
      const { $ref: _reference, ...siblings } = node; return { ...resolve(next, seen), ...siblings };
    }
    if (all !== undefined) {
      if (!Array.isArray(all) || all.length !== 1) throw new BoundaryError('RESOURCE_INVALID');
      const { allOf: _all, ...siblings } = node; return { ...resolve(all[0], seen), ...siblings };
    }
    return node;
  }
  function typeName(node: Record<string, unknown>): string {
    if (node.type === 'array') { const inner = resolve(node.items); return `array<${typeof inner.type === 'string' ? inner.type : 'object'}>`; }
    if (typeof node.type === 'string' && ['object', 'string', 'integer', 'number', 'boolean'].includes(node.type)) return node.type;
    if (node.properties || node.additionalProperties) return 'object';
    if (node.oneOf || node.anyOf) return 'union'; return 'unspecified';
  }
  let node = resolve(roots[0]), required = false;
  for (const field of request.fieldPath) {
    if (node.type === 'array') node = resolve(node.items);
    const properties = node.properties === undefined ? {} : object(node.properties), child = own(properties, field);
    required = Array.isArray(node.required) && node.required.includes(field);
    if (child !== undefined) node = resolve(child);
    else if (node.additionalProperties && typeof node.additionalProperties === 'object') { node = resolve(node.additionalProperties); required = false; }
    else throw new BoundaryError('NOT_FOUND');
  }
  const properties = node.properties === undefined ? {} : object(node.properties), names = Object.keys(properties);
  if (names.length > 100) throw new BoundaryError('BUDGET_EXCEEDED');
  const result = explanationSchema.safeParse({ type: typeName(node), description: node.description ?? '', required,
    properties: names.map(name => ({ name, type: typeName(resolve(properties[name])), required: Array.isArray(node.required) && node.required.includes(name) })) });
  if (!result.success) throw new BoundaryError('BUDGET_EXCEEDED'); return result.data;
}
