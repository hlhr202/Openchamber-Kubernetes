import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters, namespaceName } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { PrivateMergedConfig } from './kubeconfig.ts';

const text = z.string().max(2_000_000);
const path = z.string().max(4096).refine(value => !containsControlCharacters(value));
const clusterSchema = z.object({ server: z.string().min(1).max(8192), 'tls-server-name': text.optional(), 'insecure-skip-tls-verify': z.boolean().optional(),
  'certificate-authority': path.optional(), 'certificate-authority-data': text.optional(), 'proxy-url': text.optional(), 'disable-compression': z.boolean().optional() }).strict();
const userSchema = z.object({ token: text.optional(), tokenFile: path.optional(), username: text.optional(), password: text.optional(),
  'client-certificate': path.optional(), 'client-certificate-data': text.optional(), 'client-key': path.optional(), 'client-key-data': text.optional(),
  as: text.optional(), 'as-uid': text.optional(), 'as-groups': z.array(text).max(128).optional(), 'as-user-extra': z.record(z.string(), z.array(text).max(128)).optional() }).strict();

const snapshotSchema = z.object({ apiVersion: z.literal('v1'), kind: z.literal('Config'), 'current-context': boundedName,
  clusters: z.array(z.object({ name: boundedName, cluster: clusterSchema }).strict()).length(1),
  users: z.array(z.object({ name: boundedName, user: userSchema }).strict()).max(1),
  contexts: z.array(z.object({ name: boundedName, context: z.object({ cluster: boundedName, user: boundedName.optional(), namespace: namespaceName }).strict() }).strict()).length(1),
}).strict();

// Revalidates a private IPC snapshot without reading a file or executing authentication.
export function validateKubectlSnapshot(input: Uint8Array, target: TargetIdentity): void {
  if (input.byteLength > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)) as unknown; }
  catch { throw new BoundaryError('CONFIG_INVALID'); }
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  const config = parsed.data, context = config.contexts[0], cluster = config.clusters[0], user = config.users[0];
  if (!context || !cluster || config['current-context'] !== target.context || context.name !== target.context || context.context.namespace !== target.namespace
    || context.context.cluster !== cluster.name || (context.context.user ? user?.name !== context.context.user : !!user)) throw new BoundaryError('STALE_TARGET');
  for (const reference of [cluster.cluster['certificate-authority'], user?.user.tokenFile, user?.user['client-certificate'], user?.user['client-key']]) {
    if (reference && !isAbsolute(reference)) throw new BoundaryError('CONFIG_INVALID');
  }
  // The same server URL validation as the parent snapshot builder; no fallback identity.
  privateKubectlConfiguration({ sources: [], currentContext: target.context,
    clusters: new Map([[cluster.name, { sourcePath: '/read-worker/config', value: cluster.cluster }]]),
    users: new Map(user ? [[user.name, { sourcePath: '/read-worker/config', value: user.user }]] : []),
    contexts: new Map([[context.name, { sourcePath: '/read-worker/config', value: context.context }]]) }, target).fill(0);
}

function fileReference(value: string | undefined, sourcePath: string): string | undefined {
  if (value === undefined || !value) return value;
  if (!isAbsolute(sourcePath)) throw new BoundaryError('CONFIG_INVALID');
  return isAbsolute(value) ? value : resolve(dirname(sourcePath), value);
}

// Static credential methods only. No provider/exec/unknown fallback is allowed to run under
// an isolated HOME until its original environment and persistence semantics are implemented.
export function privateKubectlConfiguration(config: PrivateMergedConfig, target: TargetIdentity): Uint8Array {
  const context = config.contexts.get(target.context);
  if (!context || config.currentContext !== target.context || (context.value.namespace || 'default') !== target.namespace) throw new BoundaryError('STALE_TARGET');
  const cluster = config.clusters.get(context.value.cluster ?? '');
  const userName = context.value.user ?? '', user = config.users.get(userName);
  if (!cluster || (userName && !user)) throw new BoundaryError('CONFIG_REFERENCE_MISSING');
  const parsedCluster = clusterSchema.safeParse(cluster.value), parsedUser = userSchema.safeParse(user?.value ?? {});
  if (!parsedCluster.success || !parsedUser.success) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  let server: URL;
  try { server = new URL(parsedCluster.data.server); } catch { throw new BoundaryError('CONFIG_INVALID'); }
  if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.hash || server.search) throw new BoundaryError('CONFIG_INVALID');
  const clusterValue = { ...parsedCluster.data };
  if (clusterValue['certificate-authority'] !== undefined) clusterValue['certificate-authority'] = fileReference(clusterValue['certificate-authority'], cluster.sourcePath) ?? '';
  const userValue = { ...parsedUser.data };
  for (const name of ['tokenFile', 'client-certificate', 'client-key'] as const) {
    if (userValue[name] !== undefined && user) userValue[name] = fileReference(userValue[name], user.sourcePath) ?? '';
  }
  // One selected, immutable in-memory snapshot for the owned FIFO; no credential flag, environment constant,
  // temporary credential file, original config migration or default/in-cluster fallback.
  const value = { apiVersion: 'v1', kind: 'Config', 'current-context': target.context,
    clusters: [{ name: context.value.cluster, cluster: clusterValue }], users: userName ? [{ name: userName, user: userValue }] : [],
    contexts: [{ name: target.context, context: { cluster: context.value.cluster, ...(userName ? { user: userName } : {}), namespace: target.namespace } }] };
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  return bytes;
}
