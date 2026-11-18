import { z } from 'zod';
import { boundedName, namespaceName, targetSchema } from './identity.ts';
import { authenticationSchema, configPageQuerySchema, configSelectionSchema, configSourcesSchema } from './configuration.ts';

export const protocolVersion = 2;
export const healthSchema = z.object({
  protocol: z.literal(protocolVersion), status: z.literal('ready'), serviceGeneration: boundedName,
  version: boundedName, compatibility: z.literal('2.5.1'),
}).strict();
export type ServiceHealth = z.infer<typeof healthSchema>;
export const configPageSchema = z.object({
  protocol: z.literal(protocolVersion), serviceGeneration: boundedName, configIdentity: boundedName,
  status: z.enum(['ready', 'missing']), total: z.number().int().min(0).max(5000), nextOffset: z.number().int().min(0).max(5000).nullable(),
  currentContextMissing: z.boolean(), currentContext: z.string().max(1024),
  currentContextInfo: z.object({ name: boundedName, namespace: namespaceName, available: z.boolean(), authentication: authenticationSchema.optional() }).strict().nullable(),
  sources: configSourcesSchema,
  contexts: z.array(z.object({ name: boundedName, clusterName: z.string().max(1024), namespace: z.string().max(63), active: z.boolean(), available: z.boolean(), authentication: authenticationSchema }).strict()).max(100),
}).strict().refine(value => value.contexts.every(context => context.active === (context.name === value.currentContext))
  && (!!value.currentContext && !value.currentContextMissing) === (value.currentContextInfo !== null)
  && (!value.currentContextInfo || value.currentContextInfo.name === value.currentContext)
  && value.contexts.every(context => !context.active || (value.currentContextInfo?.namespace === context.namespace && value.currentContextInfo.available === context.available))
  && (!value.currentContextMissing || value.contexts.every(context => !context.active)));
export type ConfigPage = z.infer<typeof configPageSchema>;
// The global current summary is projected before pagination. Never infer the active read target from this page's rows.
export function configurationReadTarget(config: ConfigPage | undefined, projectId: string) {
  if (!config || config.status !== 'ready' || config.currentContextMissing || !config.currentContextInfo?.available) return undefined;
  const result = targetSchema.safeParse({ serviceGeneration: config.serviceGeneration, projectId, configIdentity: config.configIdentity,
    context: config.currentContextInfo.name, namespace: config.currentContextInfo.namespace });
  return result.success ? result.data : undefined;
}
export const configReadRequestSchema = z.object({ protocol: z.literal(protocolVersion), selection: configSelectionSchema, page: configPageQuerySchema }).strict();
