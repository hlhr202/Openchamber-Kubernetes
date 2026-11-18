import { BoundaryError } from '../../shared/errors.ts';
import { containsControlCharacters, resourceTypeSchema, targetSchema } from '../../shared/identity.ts';
import { definitionReferenceSchema } from '../../shared/branch-protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import type { ResourceType, TargetIdentity } from '../../shared/identity.ts';
import type { ResourceReadRequest } from './resource-reader.ts';

// Only list rows whose presentation needs no spec/status/data. Single-object
// CRD proof, discovery, Watch and Pod/Deployment/Service lists are unchanged.
const types = Object.values(resourceDescriptors).filter(type => !['pods', 'deployments', 'services'].includes(type.resource));
export const crdCollectionPath = '/apis/apiextensions.k8s.io/v1/customresourcedefinitions';
const collectionPath = (type: ResourceType, target: TargetIdentity) =>
  `${type.group ? `/apis/${type.group}` : '/api'}/${type.version}${type.scope === 'namespace' ? `/namespaces/${target.namespace}` : ''}/${type.resource}`;

export function prefersResourceListMetadata(type: ResourceType): boolean {
  return types.some(value => value.group === type.group && value.version === type.version && value.resource === type.resource
    && value.kind === type.kind && value.scope === type.scope);
}

export function isMetadataCollectionPath(path: string, target: TargetIdentity): boolean {
  return types.some(type => path === collectionPath(type, target));
}

export function isCustomMetadataType(type: ResourceType, definitionName: string): boolean {
  return !!type.group && definitionName === `${type.resource}.${type.group}`
    && !Object.values(resourceDescriptors).some(value => value.group === type.group && value.resource === type.resource)
    && !(type.group === 'apiextensions.k8s.io' && type.resource === 'customresourcedefinitions');
}

export const metadataListAccept = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1, application/json;q=0.9';

export function validateMetadataListRead(request: ResourceReadRequest): void {
  const { query, target } = request;
  if (request.method !== 'GET' || request.representation !== 'metadata-preferred'
    || request.maximumBytes !== 2_000_000 || !targetSchema.safeParse(target).success
    || request.customDocument || request.customInspection || request.customWatch || request.comparison || request.createReference
    || Object.keys(query).some(name => name !== 'limit' && name !== 'continue') || !/^(?:[1-9][0-9]?|100)$/.test(query.limit ?? '')
    || (query.continue !== undefined && (!query.continue || query.continue.length > 8192 || containsControlCharacters(query.continue)))) throw new BoundaryError('INVALID_INPUT');
  if (request.customList) {
    const { type, definition } = request.customList;
    if (request.purpose !== 'resource-list' || !resourceTypeSchema.safeParse(type).success || !definitionReferenceSchema.safeParse(definition).success
      || !isCustomMetadataType(type, definition.name) || request.path !== collectionPath(type, target)) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'custom-resource-definitions' ? request.path !== crdCollectionPath
    : request.purpose !== 'resource-list' || !isMetadataCollectionPath(request.path, target)) throw new BoundaryError('INVALID_INPUT');
}
