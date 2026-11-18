import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import type { AuthenticationDisclosure } from '../../shared/configuration.ts';

const privateFields = z.record(z.string(), z.unknown());
const clusterEntry = z.object({ name: boundedName, cluster: privateFields });
const userEntry = z.object({ name: boundedName, user: privateFields });
const optionalReference = z.union([z.literal(''), boundedName]);
const namespaceName = z.string().max(63).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/);
const contextEntry = z.object({ name: boundedName, context: z.object({ cluster: optionalReference.optional(), user: optionalReference.optional(), namespace: namespaceName.optional() }) });
const configSchema = z.object({
  apiVersion: z.literal('v1').optional(), kind: z.literal('Config').optional(),
  clusters: z.array(clusterEntry).max(5000).nullable().optional(), users: z.array(userEntry).max(5000).nullable().optional(),
  contexts: z.array(contextEntry).max(5000).nullable().optional(), 'current-context': z.string().max(1024).optional(),
});
type Config = z.infer<typeof configSchema>;
type Located<T> = { readonly sourcePath: string; readonly value: T };
export type PrivateMergedConfig = {
  readonly sources: readonly string[];
  readonly clusters: ReadonlyMap<string, Located<Record<string, unknown>>>;
  readonly users: ReadonlyMap<string, Located<Record<string, unknown>>>;
  readonly contexts: ReadonlyMap<string, Located<NonNullable<Config['contexts']>[number]['context']>>;
  readonly currentContext: string;
};
export type ConfigInput = { readonly sourcePath: string; readonly originPath?: string; readonly content: string };

export function parseConfig(content: string): Config {
  if (Buffer.byteLength(content) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  try {
    const doc = parseDocument(content, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new BoundaryError('CONFIG_INVALID');
    const value: unknown = doc.toJS({ maxAliasCount: 50 });
    const result = configSchema.safeParse(value ?? {});
    if (!result.success) throw new BoundaryError('CONFIG_INVALID');
    for (const entries of [result.data.clusters, result.data.users, result.data.contexts]) {
      if (entries && new Set(entries.map(entry => entry.name)).size !== entries.length) throw new BoundaryError('CONFIG_INVALID');
    }
    return result.data;
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    // Never expose YAML source snippets or unknown/custom tag content through error messages.
    throw new BoundaryError('CONFIG_INVALID');
  }
}

export function mergeConfigSources(inputs: readonly ConfigInput[]): PrivateMergedConfig {
  if (inputs.length > 64 || inputs.reduce((sum, input) => sum + Buffer.byteLength(input.content), 0) > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  const clusters = new Map<string, Located<Record<string, unknown>>>();
  const users = new Map<string, Located<Record<string, unknown>>>();
  const contexts = new Map<string, Located<NonNullable<Config['contexts']>[number]['context']>>();
  const sources: string[] = [];
  let currentContext = '';
  for (const input of inputs) {
    if (!input.sourcePath || sources.includes(input.sourcePath)) continue;
    sources.push(input.sourcePath);
    const config = parseConfig(input.content);
    currentContext ||= config['current-context'] ?? '';
    const sourcePath = input.originPath ?? input.sourcePath;
    for (const entry of config.clusters ?? []) if (!clusters.has(entry.name)) clusters.set(entry.name, { sourcePath, value: entry.cluster });
    for (const entry of config.users ?? []) if (!users.has(entry.name)) users.set(entry.name, { sourcePath, value: entry.user });
    for (const entry of config.contexts ?? []) if (!contexts.has(entry.name)) contexts.set(entry.name, { sourcePath, value: entry.context });
    if (clusters.size > 5000 || users.size > 5000 || contexts.size > 5000) throw new BoundaryError('BUDGET_EXCEEDED');
  }
  return { sources, clusters, users, contexts, currentContext };
}

function authenticationDisclosure(user: Record<string, unknown> | undefined, cluster: Record<string, unknown> | undefined, missingReference: boolean): AuthenticationDisclosure {
  const methods: AuthenticationDisclosure['methods'] = [];
  const has = (key: string) => user !== undefined && Object.hasOwn(user, key);
  if (has('token')) methods.push('token');
  if (has('tokenFile')) methods.push('token-file');
  if (['client-certificate', 'client-certificate-data', 'client-key', 'client-key-data'].some(has)) methods.push('client-certificate');
  if (has('username') || has('password')) methods.push('basic');
  if (has('exec')) methods.push('exec');
  if (has('auth-provider')) methods.push('auth-provider');
  const known = new Set(['token', 'tokenFile', 'client-certificate', 'client-certificate-data', 'client-key', 'client-key-data', 'username', 'password', 'exec', 'auth-provider', 'as', 'as-uid', 'as-groups', 'as-user-extra']);
  if (missingReference || (user && Object.keys(user).some(key => !known.has(key)))) methods.push('unknown');
  if (!methods.length) methods.push('anonymous');
  return {
    methods, externalExecution: has('exec') || has('auth-provider'),
    referencedFiles: ['tokenFile', 'client-certificate', 'client-key'].some(has) || (cluster !== undefined && Object.hasOwn(cluster, 'certificate-authority')),
    mayUpdateCredentials: has('exec') || has('auth-provider') || methods.includes('unknown'),
    proxyConfigured: cluster !== undefined && Object.hasOwn(cluster, 'proxy-url'), evaluated: false,
  };
}

export function publicConfigSnapshot(config: PrivateMergedConfig, configIdentity: string) {
  if (!boundedName.safeParse(configIdentity).success) throw new BoundaryError('INVALID_INPUT');
  const contexts = [...config.contexts].map(([name, { value }]) => {
    const clusterName = value.cluster ?? '';
    const userName = value.user ?? '';
    const available = config.clusters.has(clusterName) && (!userName || config.users.has(userName));
    return { name, clusterName, namespace: value.namespace || 'default', active: name === config.currentContext, available,
      authentication: authenticationDisclosure(config.users.get(userName)?.value, config.clusters.get(clusterName)?.value, !!userName && !config.users.has(userName)) };
  });
  return { configIdentity, contexts, currentContext: config.currentContext, currentContextMissing: !!config.currentContext && !config.contexts.has(config.currentContext) };
}
// Explicit discovery preview only, never a target proof, source path or write grant.
// Credentials and raw kubeconfig never cross this result boundary.
export function publicConfigSummary(text: string) {
  if (Buffer.byteLength(text) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
  const config = parseConfig(text);
  return { currentContext: config['current-context'] ?? '', contexts: (config.contexts ?? []).map(entry => ({
    name: entry.name, clusterName: entry.context.cluster ?? '', namespace: entry.context.namespace || 'default',
  })) };
}
