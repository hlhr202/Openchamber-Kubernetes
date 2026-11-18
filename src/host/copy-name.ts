import { z } from 'zod';
import { BoundaryError } from '../shared/errors.ts';
import { boundedName, hasWellFormedUnicode, sameTarget, targetSchema } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { ConfigurationState } from './configuration-client.ts';
import type { ResourceState } from './resource-client.ts';
import type { BranchState } from './branch-client.ts';
import type { TreeSnapshot } from './tree-controller.ts';

const node = { id: z.string().min(1).max(16_000), target: targetSchema };
export const copyNameSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), id: boundedName, serviceGeneration: boundedName, configIdentity: boundedName }).strict(),
  z.object({ kind: z.literal('resource'), ...node }).strict(),
  z.object({ kind: z.literal('branch'), ...node }).strict(),
  z.object({ kind: z.literal('tree'), rowId: z.string().min(1).max(16_000), generation: z.number().int().nonnegative(), serviceGeneration: boundedName, configIdentity: boundedName }).strict(),
]);
export type CopyNameSelection = z.infer<typeof copyNameSelectionSchema>;
export function copyTreeNameText(input: unknown, configuration: ConfigurationState | undefined, tree: TreeSnapshot): string {
  const parsed = copyNameSelectionSchema.safeParse(input); if (!parsed.success || parsed.data.kind !== 'tree') throw new BoundaryError('INVALID_INPUT');
  const request = parsed.data;
  if (configuration?.phase !== 'ready' || configuration.stale || configuration.config?.status !== 'ready') throw new BoundaryError('STALE_TARGET');
  const config = configuration.config;
  if (request.serviceGeneration !== config.serviceGeneration || request.configIdentity !== config.configIdentity
    || tree.roots.phase !== 'ready' || tree.generation !== request.generation) throw new BoundaryError('STALE_TARGET');
  const row = tree.rows.find(item => item.id === request.rowId);
  if (!row) throw new BoundaryError('INVALID_INPUT');
  let text: string | undefined;
  if (row.entry.node.type === 'context') text = row.entry.node.label;
  else if (row.entry.node.type === 'resource') text = row.entry.node.resource?.name;
  else if (row.entry.node.type === 'config-key') text = row.entry.node.key;
  else if (row.entry.node.type === 'release') text = row.entry.node.release?.name ?? row.entry.node.label;
  if (!text || !boundedName.safeParse(text).success || !hasWellFormedUnicode(text)) throw new BoundaryError('INVALID_INPUT');
  return text;
}
// Pure projection only. No SDK, clipboard callback, I/O, query, storage or operation imports.
export function copyNameText(input: unknown, configuration: ConfigurationState | undefined, resources: ResourceState, branches: BranchState, target: TargetIdentity | undefined): string {
  const parsed = copyNameSelectionSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
  if (configuration?.phase !== 'ready' || configuration.stale || configuration.config?.status !== 'ready') throw new BoundaryError('STALE_TARGET');
  const config = configuration.config; let text: string | undefined;
  if (request.kind === 'context') {
    if (request.serviceGeneration !== config.serviceGeneration || request.configIdentity !== config.configIdentity) throw new BoundaryError('STALE_TARGET');
    text = config.contexts.find(context => context.name === request.id)?.name; // Never the decorated active-context label.
  } else if (request.kind === 'tree') {
    throw new BoundaryError('INVALID_INPUT');
  } else {
    if (!target || !sameTarget(request.target, target)) throw new BoundaryError('STALE_TARGET');
    const state = request.kind === 'resource' ? resources : branches;
    if (state.phase !== 'ready' || state.stale || !state.page || !sameTarget(state.page.target, target)) throw new BoundaryError('STALE_TARGET');
    const selected = state.page.nodes.find(item => item.id === request.id);
    if (selected?.type === 'resource') text = selected.resource.name; // Not label, tooltip, spec, Secret data or document text.
    // Upstream copiableName also handles config keys. The default key menu/Helm release renderer remain separate work.
    else if (selected?.type === 'config-key') text = selected.key;
  }
  if (!text || !boundedName.safeParse(text).success || !hasWellFormedUnicode(text)) throw new BoundaryError('INVALID_INPUT');
  return text;
}
