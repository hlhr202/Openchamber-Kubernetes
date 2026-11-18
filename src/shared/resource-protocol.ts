import { z } from 'zod';
import { boundedName, namespaceName, resourceTypeSchema, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { protocolVersion } from './protocol.ts';
import { resourceDescriptors } from './tree.ts';
import { forwardPortHintsSchema } from './forward-port-hints.ts';

export const resourceRequestBytes = 48_000;
export const builtinResourceKey = z.string().max(64).refine(value => Object.hasOwn(resourceDescriptors, value));
export const resourceReadRequestSchema = z.object({ protocol: z.literal(protocolVersion), selection: configSelectionSchema,
  target: targetSchema, resource: builtinResourceKey, cursor: z.string().min(1).max(17_000).optional() }).strict();
export const resourceIdentitySchema = resourceTypeSchema.extend({ name: boundedName, namespace: namespaceName.optional(), uid: boundedName.optional(), resourceVersion: boundedName.optional() });
export const resourceNodeSchema = z.object({ id: z.string().min(1).max(16_000), type: z.literal('resource'), label: boundedName, expandable: z.boolean(), resource: resourceIdentitySchema,
  forwardPorts: forwardPortHintsSchema.optional(),
  children: z.enum(['none', 'pods-on-node', 'selected-pods', 'pod-info', 'config-keys']), tooltip: boundedName.optional(),
  icon: z.enum(['pod-running', 'pod-not-ready', 'pod-completed', 'pod-error', 'workload-ready', 'workload-progressing', 'workload-error', 'workload-paused']).optional() }).strict()
  .refine(node => node.forwardPorts === undefined || (node.resource.group === '' && node.resource.version === 'v1'
    && ((node.resource.resource === 'pods' && node.resource.kind === 'Pod') || (node.resource.resource === 'services' && node.resource.kind === 'Service'))));
export const resourceReadResponseSchema = z.object({ protocol: z.literal(protocolVersion), target: targetSchema, resource: builtinResourceKey,
  nodes: z.array(resourceNodeSchema).max(100), resourceVersion: boundedName, nextCursor: z.string().min(1).max(17_000).nullable() }).strict();
export type ResourceReadResponse = z.infer<typeof resourceReadResponseSchema>;
