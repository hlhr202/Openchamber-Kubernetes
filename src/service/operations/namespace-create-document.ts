import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, namespaceName } from '../../shared/identity.ts';
import { parseConfig } from '../queries/kubeconfig.ts';

// WRITE planner, static review only. Never called by automatic tests (including no-op/rejection paths).
// Insert only the missing named context. Never re-serialize credentials, current-context or existing stanzas.
export function namespaceCreateDocument(source: string, contextName: string, namespace: string, allowExternalCurrent = false): string {
  if (!boundedName.safeParse(contextName).success || !namespaceName.safeParse(namespace).success) throw new BoundaryError('INVALID_INPUT');
  try {
    const config = parseConfig(source);
    if ((!allowExternalCurrent && config['current-context'] !== contextName) || config.contexts?.some(entry => entry.name === contextName)) throw new BoundaryError('STALE_TARGET');
    const doc = parseDocument(source, { uniqueKeys: true, strict: true, intAsBigInt: true });
    if (doc.errors.length || doc.warnings.length) throw new BoundaryError('CONFIG_INVALID');
    let nodes = 0;
    const inspect = (node: unknown, depth: number): void => {
      if (node === null || node === undefined) return;
      if (!isNode(node) || isAlias(node) || node.tag || node.anchor) throw new BoundaryError('CONFIG_INVALID');
      if (++nodes > 50_000 || depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || pair.key.value === '<<') throw new BoundaryError('CONFIG_INVALID');
        inspect(pair.key, depth + 1); inspect(pair.value, depth + 1);
      }
      else if (isSeq(node)) for (const value of node.items) inspect(value, depth + 1);
    };
    inspect(doc.contents, 0);
    const entry = JSON.stringify({ name: contextName, context: { namespace } }), newline = source.includes('\r\n') ? '\r\n' : '\n';
    const appendLine = (end: number, line: string) => {
      if (end < source.length && source[end - 1] !== '\n') throw new BoundaryError('CONFIG_INVALID');
      return source.slice(0, end) + (end && source[end - 1] !== '\n' ? newline : '') + line + newline + source.slice(end);
    };
    let next: string;
    if (doc.contents === null) {
      // An earlier existing source may be comments-only while a later source owns the global current name.
      if (!source.split(/\r?\n/).every(line => /^\s*(?:#.*)?$/.test(line))) throw new BoundaryError('CONFIG_INVALID');
      next = appendLine(source.length, `contexts: [${entry}]`);
    } else {
      if (!isMap(doc.contents) || !doc.contents.range) throw new BoundaryError('CONFIG_INVALID');
      const contexts = doc.contents.get('contexts', true);
      if (!doc.contents.has('contexts')) {
        if (doc.contents.flow) {
          const end = doc.contents.range[1] - 1; if (source[end] !== '}') throw new BoundaryError('CONFIG_INVALID');
          next = source.slice(0, end) + `${doc.contents.items.length ? ',' : ''}"contexts":[${entry}]` + source.slice(end);
        } else next = appendLine(doc.contents.range[1], `contexts: [${entry}]`);
      } else if (isScalar(contexts) && contexts.value === null && contexts.range) {
        next = source.slice(0, contexts.range[0]) + ` [${entry}]` + source.slice(contexts.range[1]);
      } else if (isSeq(contexts) && contexts.range) {
        if (contexts.flow) {
          const end = contexts.range[1] - 1; if (source[end] !== ']') throw new BoundaryError('CONFIG_INVALID');
          next = source.slice(0, end) + `${contexts.items.length ? ',' : ''}${entry}` + source.slice(end);
        } else {
          const start = contexts.range[0], line = source.lastIndexOf('\n', start - 1) + 1, indent = source.slice(line, start);
          if (!/^ *$/.test(indent) || source[start] !== '-') throw new BoundaryError('CONFIG_INVALID');
          next = appendLine(contexts.range[1], `${indent}- ${entry}`);
        }
      } else throw new BoundaryError('CONFIG_INVALID');
    }
    const after = parseConfig(next), created = after.contexts?.find(value => value.name === contextName);
    if (after['current-context'] !== config['current-context'] || after.contexts?.length !== (config.contexts?.length ?? 0) + 1
      || created?.context.namespace !== namespace || created.context.cluster !== undefined || created.context.user !== undefined) throw new BoundaryError('CONFIG_INVALID');
    return next;
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_INVALID'); }
}
