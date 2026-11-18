import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { BoundaryError } from '../../shared/errors.ts';
import { mergeConfigSources, parseConfig } from '../queries/kubeconfig.ts';
import type { ConfigInput } from '../queries/kubeconfig.ts';
import type { ContextDeleteStep } from '../../shared/context-delete-protocol.ts';

export type EntrySection = 'clusters' | 'users' | 'contexts';
// WRITE planners, including no-op/validation branches. Never import or invoke from automatic tests.
export function contextDeleteDescription(source: string, context: string) {
  const config = parseConfig(source), target = config.contexts?.find(value => value.name === context);
  if (!target) throw new BoundaryError('NOT_FOUND');
  const cluster = target.context.cluster ?? '', user = target.context.user ?? '';
  const sharedCluster = (config.contexts ?? []).filter(value => value.name !== context && value.context.cluster === cluster).length;
  const sharedUser = (config.contexts ?? []).filter(value => value.name !== context && value.context.user === user).length;
  const describe = <T extends 'cluster' | 'user'>(id: T, name: string, exists: boolean, sharedReferences: number): Omit<LegacyStep, 'id'> & { id: T } => ({ id, name,
    dependencies: id === 'user' ? ['cluster'] : [], phase: name && exists && !sharedReferences ? 'planned' : 'skipped',
    reason: !name ? 'empty' : !exists ? 'absent' : sharedReferences ? 'shared' : 'exclusive', sharedReferences, cleanup: 'none' });
  const steps: ContextDeleteOutcomeSteps = [
    describe('cluster', cluster, !!config.clusters?.some(value => value.name === cluster), sharedCluster),
    describe('user', user, !!config.users?.some(value => value.name === user), sharedUser),
    { id: 'context', name: context, dependencies: ['cluster', 'user'], phase: 'planned', reason: 'target', sharedReferences: 0, cleanup: 'none' },
  ];
  return { currentContextRetained: config['current-context'] ?? '', steps };
}
type LegacyStep = Omit<ContextDeleteStep, 'path' | 'nextOrigin' | 'shadowDefinitions'>;
type ContextDeleteOutcomeSteps = [LegacyStep & { id: 'cluster' }, LegacyStep & { id: 'user' }, LegacyStep & { id: 'context' }];

export function contextDeleteSourcesDescription(inputs: readonly ConfigInput[], context: string) {
  const merged = mergeConfigSources(inputs), target = merged.contexts.get(context);
  if (!target) throw new BoundaryError('NOT_FOUND');
  const parsed = inputs.map(input => ({ path: input.originPath ?? input.sourcePath, config: parseConfig(input.content) }));
  const cluster = target.value.cluster ?? '', user = target.value.user ?? '';
  // Protect references in ALL physical definitions, including hidden contexts that may become effective later.
  const others = parsed.flatMap(source => (source.config.contexts ?? []).filter(entry => !(source.path === target.sourcePath && entry.name === context)));
  const describe = <T extends 'cluster' | 'user' | 'context'>(id: T, name: string): Omit<ContextDeleteStep, 'id'> & { id: T } => {
    const paths = parsed.filter(source => id === 'context' ? source.config.contexts?.some(entry => entry.name === name)
      : id === 'cluster' ? source.config.clusters?.some(entry => entry.name === name) : source.config.users?.some(entry => entry.name === name)).map(source => source.path);
    const sharedReferences = !name || id === 'context' ? 0 : others.filter(entry => entry.context[id === 'cluster' ? 'cluster' : 'user'] === name).length;
    return { id, name, dependencies: id === 'cluster' ? [] : id === 'user' ? ['cluster'] : ['cluster', 'user'], path: paths[0] ?? null, nextOrigin: paths[1] ?? null, shadowDefinitions: Math.max(0, paths.length - 1),
      sharedReferences, phase: id === 'context' || (name && paths.length && !sharedReferences) ? 'planned' : 'skipped',
      reason: id === 'context' ? 'target' : !name ? 'empty' : !paths.length ? 'absent' : sharedReferences ? 'shared' : 'exclusive', cleanup: 'none' };
  };
  const steps: [ContextDeleteStep & { id: 'cluster' }, ContextDeleteStep & { id: 'user' }, ContextDeleteStep & { id: 'context' }] = [describe('cluster', cluster), describe('user', user), describe('context', context)];
  const nextSource = parsed.find(source => source.path === steps[2].nextOrigin), next = nextSource?.config.contexts?.find(entry => entry.name === context)?.context;
  const contextAfter = next && nextSource ? { origin: nextSource.path, cluster: next.cluster ?? '', user: next.user ?? '', namespace: next.namespace || 'default' } : null;
  return { currentContextRetained: merged.currentContext, contextRemains: steps[2].shadowDefinitions > 0, contextAfter, steps, cluster, user };
}

export function deleteEntryDocument(source: string, section: EntrySection, name: string, context: string, allowExternalContext = false): string {
  try {
    const config = parseConfig(source);
    if (!allowExternalContext && !config.contexts?.some(value => value.name === context)) throw new BoundaryError('NOT_FOUND');
    if (section !== 'contexts' && config.contexts?.some(value => value.name !== context && value.context[section === 'clusters' ? 'cluster' : 'user'] === name)) throw new BoundaryError('CONFLICT');
    const doc = parseDocument(source, { uniqueKeys: true, strict: true, intAsBigInt: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.flow) throw new BoundaryError('CONFIG_INVALID');
    let count = 0;
    const inspect = (node: unknown, depth: number): void => {
      if (node === null || node === undefined) return;
      if (!isNode(node) || isAlias(node) || node.tag || node.anchor) throw new BoundaryError('CONFIG_INVALID');
      if (++count > 50_000 || depth > 64) throw new BoundaryError('BUDGET_EXCEEDED');
      if (isMap(node)) for (const pair of node.items) { if (!isScalar(pair.key) || pair.key.value === '<<') throw new BoundaryError('CONFIG_INVALID'); inspect(pair.key, depth + 1); inspect(pair.value, depth + 1); }
      else if (isSeq(node)) for (const value of node.items) inspect(value, depth + 1);
    };
    inspect(doc.contents, 0);
    const sequence = doc.contents.get(section, true);
    if (!isSeq(sequence) || sequence.flow) throw new BoundaryError('CONFIG_INVALID');
    const target = sequence.items.find(value => isMap(value) && value.get('name') === name);
    if (!isMap(target) || target.flow || !target.range) throw new BoundaryError('NOT_FOUND');
    const start = source.lastIndexOf('\n', target.range[0] - 1) + 1, prefix = source.slice(start, target.range[0]), end = target.range[2];
    if (!/^ *- +$/.test(prefix) || (end < source.length && source[end - 1] !== '\n')) throw new BoundaryError('CONFIG_INVALID');
    const indent = prefix.indexOf('-'), newline = source.includes('\r\n') ? '\r\n' : '\n';
    const replacement = sequence.items.length === 1 ? `${' '.repeat(indent + 2)}[]${newline}` : '';
    const next = source.slice(0, start) + replacement + source.slice(end), after = parseConfig(next);
    if ((after[section] ?? []).some(value => value.name === name) || (after[section] ?? []).length !== (config[section] ?? []).length - 1
      || after['current-context'] !== config['current-context']) throw new BoundaryError('CONFIG_INVALID');
    return next; // Unrelated source ranges, credentials, comments and numeric lexemes are never reserialized.
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_INVALID'); }
}
