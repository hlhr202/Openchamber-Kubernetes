import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { parseConfig } from '../queries/kubeconfig.ts';

// WRITE planner. Static review only, including rejection/no-op branches. Never invoked by tests.
export function contextDocument(source: string, previous: string, context: string, allowExternalContext = false): string {
  if (!boundedName.safeParse(context).success) throw new BoundaryError('INVALID_INPUT');
  try {
    const config = parseConfig(source);
    if ((config['current-context'] ?? '') !== previous) throw new BoundaryError('CONFIG_CHANGED');
    if (!allowExternalContext && !config.contexts?.some(value => value.name === context)) throw new BoundaryError('NOT_FOUND');
    const doc = parseDocument(source, { uniqueKeys: true, strict: true, intAsBigInt: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new BoundaryError('CONFIG_INVALID');
    let nodes = 0;
    const inspect = (node: unknown, depth: number): void => {
      if (node === null || node === undefined) return;
      if (!isNode(node) || isAlias(node)) throw new BoundaryError('CONFIG_INVALID');
      if (++nodes > 50_000 || depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
      if (node.tag || node.anchor) throw new BoundaryError('CONFIG_INVALID');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || pair.key.value === '<<') throw new BoundaryError('CONFIG_INVALID');
        inspect(pair.key, depth + 1); inspect(pair.value, depth + 1);
      }
      else if (isSeq(node)) for (const value of node.items) inspect(value, depth + 1);
    };
    inspect(doc.contents, 0);
    if (context === previous) return source;
    let next: string;
    if (doc.contents.has('current-context')) {
      const value = doc.contents.get('current-context', true);
      if (!isScalar(value) || !value.range || !['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(value.type ?? '')) throw new BoundaryError('CONFIG_INVALID');
      next = source.slice(0, value.range[0]) + JSON.stringify(context) + source.slice(value.range[1]);
    } else {
      if (doc.contents.flow || !doc.contents.range) throw new BoundaryError('CONFIG_INVALID');
      const end = doc.contents.range[1], newline = source.includes('\r\n') ? '\r\n' : '\n';
      if (end < source.length && source[end - 1] !== '\n') throw new BoundaryError('CONFIG_INVALID');
      next = source.slice(0, end) + (end && source[end - 1] !== '\n' ? newline : '') + `current-context: ${JSON.stringify(context)}${newline}` + source.slice(end);
    }
    const after = parseConfig(next);
    if (after['current-context'] !== context || (!allowExternalContext && !after.contexts?.some(value => value.name === context))) throw new BoundaryError('CONFIG_INVALID');
    return next;
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_INVALID'); }
}
