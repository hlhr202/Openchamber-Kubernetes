import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { BoundaryError } from '../../shared/errors.ts';
import { namespaceName } from '../../shared/identity.ts';
import { parseConfig } from '../queries/kubeconfig.ts';

// Part of the WRITE planner: source review only, never invoked by automatic tests.
// Surgical source-range edit: unrelated credential/extension scalars are never re-serialized.
export function namespaceDocument(source: string, contextName: string, previous: string, namespace: string, allowExternalCurrent = false): string {
  if (!namespaceName.safeParse(namespace).success) throw new BoundaryError('INVALID_INPUT');
  try {
    const config = parseConfig(source), context = config.contexts?.find(value => value.name === contextName);
    if ((!allowExternalCurrent && config['current-context'] !== contextName) || !context || (context.context.namespace || 'default') !== previous) throw new BoundaryError('STALE_TARGET');
    const doc = parseDocument(source, { uniqueKeys: true, strict: true, intAsBigInt: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new BoundaryError('CONFIG_INVALID');
    let nodes = 0;
    const inspect = (node: unknown, depth: number): void => {
      if (node === null || node === undefined) return;
      if (!isNode(node)) throw new BoundaryError('CONFIG_INVALID');
      if (++nodes > 50_000 || depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
      if (isAlias(node)) throw new BoundaryError('CONFIG_INVALID');
      if (node.tag || node.anchor) throw new BoundaryError('CONFIG_INVALID');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || pair.key.value === '<<') throw new BoundaryError('CONFIG_INVALID');
        inspect(pair.key, depth + 1); inspect(pair.value, depth + 1);
      }
      else if (isSeq(node)) for (const value of node.items) inspect(value, depth + 1);
    };
    inspect(doc.contents, 0);
    const contexts = doc.get('contexts'); if (!isSeq(contexts)) throw new BoundaryError('CONFIG_INVALID');
    const entry = contexts.items.find(value => isMap(value) && value.get('name') === contextName);
    if (!isMap(entry)) throw new BoundaryError('CONFIG_INVALID');
    const mapping = entry.get('context'); if (!isMap(mapping)) throw new BoundaryError('CONFIG_INVALID');
    if (namespace === previous) return source;
    let next: string;
    if (mapping.has('namespace')) {
      const value = mapping.get('namespace', true);
      if (!isScalar(value) || !value.range || !['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(value.type ?? '')) throw new BoundaryError('CONFIG_INVALID');
      next = source.slice(0, value.range[0]) + JSON.stringify(namespace) + source.slice(value.range[1]);
    } else if (mapping.flow) {
      if (!mapping.range) throw new BoundaryError('CONFIG_INVALID');
      const end = mapping.range[1] - 1;
      if (source[end] !== '}') throw new BoundaryError('CONFIG_INVALID');
      let separator = '';
      if (mapping.items.length) {
        const last = mapping.items.at(-1)?.value;
        if (!isNode(last) || !last.range) throw new BoundaryError('CONFIG_INVALID');
        const tail = source.slice(last.range[1], end).replace(/#[^\r\n]*/g, '').trim();
        if (tail !== '' && tail !== ',') throw new BoundaryError('CONFIG_INVALID');
        separator = tail === ',' ? '' : ','; // Preserve an existing trailing comma/comment, never duplicate separators.
      }
      next = source.slice(0, end) + `${separator}"namespace":${JSON.stringify(namespace)}` + source.slice(end);
    } else {
      const key = mapping.items[0]?.key;
      if (!mapping.range || !isScalar(key) || !key.range) throw new BoundaryError('CONFIG_INVALID');
      const start = key.range[0], line = source.lastIndexOf('\n', start - 1) + 1, indent = source.slice(line, start), end = mapping.range[1];
      if (!/^ +$/.test(indent) || (end < source.length && source[end - 1] !== '\n')) throw new BoundaryError('CONFIG_INVALID');
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      next = source.slice(0, end) + (end && source[end - 1] !== '\n' ? newline : '') + `${indent}namespace: ${JSON.stringify(namespace)}${newline}` + source.slice(end);
    }
    const after = parseConfig(next), changed = after.contexts?.find(value => value.name === contextName);
    if (after['current-context'] !== config['current-context'] || changed?.context.namespace !== namespace || after.contexts?.length !== config.contexts?.length
      || changed.context.cluster !== context.context.cluster || changed.context.user !== context.context.user) throw new BoundaryError('CONFIG_INVALID');
    return next;
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_INVALID'); }
}
