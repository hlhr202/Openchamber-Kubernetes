import { BoundaryError } from '../../shared/errors.ts';
import { loadDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import type { LoadDocumentReference } from '../../shared/document-protocol.ts';
import type { DefinitionReference } from '../../shared/branch-protocol.ts';
import type { ResourceType } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { projectCustomResourceDefinition } from './custom-resources.ts';
import { projectDiscovery, apiDiscoveryPath } from './resource-query.ts';
import { resourceObjectPath, crdType } from './parent-resource.ts';
import { planResourceDocument } from './resource-document.ts';

// Explicit single-object Load only. Never authorizes writes/inspection/Explain or switches to another served version.
export function planLoadDocument(input: unknown, target: TargetIdentity) {
  const parsed = loadDocumentReferenceSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const reference = parsed.data;
  if (!('definition' in reference)) return { ...planResourceDocument(reference, target), custom: null };
  if (reference.type.scope === 'namespace' && reference.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
  return { reference, path: resourceObjectPath(reference.type, reference.name, reference.namespace), custom: {
    definitionPath: resourceObjectPath(crdType, reference.definition.name), discoveryPath: apiDiscoveryPath(reference.type.group, reference.type.version) } };
}
export function customDocumentProof(definitionInput: unknown, discoveryInput: unknown, reference: LoadDocumentReference | { type: ResourceType; definition: DefinitionReference }): string {
  if (!('definition' in reference)) throw new BoundaryError('INVALID_INPUT');
  const definition = projectCustomResourceDefinition(definitionInput), { type } = reference;
  if (definition.metadata.name !== reference.definition.name || definition.metadata.uid !== reference.definition.uid || definition.metadata.resourceVersion !== reference.definition.resourceVersion
    || definition.spec.group !== type.group || definition.spec.names.plural !== type.resource
    || definition.spec.names.kind !== type.kind || (definition.spec.scope === 'Namespaced' ? 'namespace' : 'cluster') !== type.scope
    || !definition.spec.versions.some(version => version.name === type.version && version.served)) throw new BoundaryError('STALE_TARGET');
  const found = projectDiscovery(discoveryInput).find(item => item.group === type.group && item.version === type.version && item.resource === type.resource);
  if (!found || found.kind !== type.kind || found.scope !== type.scope) throw new BoundaryError('STALE_TARGET');
  return JSON.stringify(definition); // Only stripped routing/identity fields; no schema, conversion webhook, annotations or instance text.
}
