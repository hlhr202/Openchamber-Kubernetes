// Private, memory-only credential projection. No executable, network or authentication refresh.
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { execPluginSpecSchema, execCredentialStatusSchema, execCredentialCacheLimits } from '../../shared/exec-credential-protocol.ts';
import type { PrivateMergedConfig } from './kubeconfig.ts';

const declaration = execPluginSpecSchema.extend({
  args: execPluginSpecSchema.shape.args.nullable(),
  env: execPluginSpecSchema.shape.env.nullable(),
  installHint: z.string().max(8192).optional(),
});
export function execAuthenticationInput(config: PrivateMergedConfig) {
  const context = config.contexts.get(config.currentContext), userName = context?.value.user;
  const user = userName ? config.users.get(userName) : undefined;
  const cluster = config.clusters.get(context?.value.cluster ?? '');
  if (!context || !user || !userName || !cluster) throw new BoundaryError('CONFIG_REFERENCE_MISSING');
  // Do not silently change precedence when multiple authentication methods are present.
  if (Object.keys(user.value).some(key => key !== 'exec')) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  const parsed = declaration.safeParse(user.value.exec);
  if (!parsed.success) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  const { installHint: _hint, args, env, ...fields } = parsed.data;
  if (fields.interactiveMode === 'Always' || (fields.apiVersion.endsWith('/v1') && !fields.interactiveMode)) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
  const command = fields.command.includes('/') && !isAbsolute(fields.command) ? resolve(dirname(user.sourcePath), fields.command) : fields.command;
  const spec = { ...fields, command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  return { spec, userName, user, cluster };
}
type Status = z.infer<typeof execCredentialStatusSchema>;
type Entry = { status: Status; expiresAt: number };
export function createAuthenticationCache(now = Date.now) {
  const entries = new Map<string, Entry>();
  const key = (identity: string, context: string) => JSON.stringify([identity, context]);
  const purge = () => { for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id); };
  return {
    has(identity: string, context: string) { purge(); return entries.has(key(identity, context)); },
    put(identity: string, context: string, status: Status, expiresAt: number) {
      purge();
      const id = key(identity, context), parsed = execCredentialStatusSchema.safeParse(status);
      if (!parsed.success || expiresAt <= now() || expiresAt > now() + execCredentialCacheLimits.maxLifetimeMs) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
      // A user can visit more clusters than the cache holds. Evict only memory, never deny authentication.
      if (!entries.has(id) && entries.size >= execCredentialCacheLimits.maxEntries) entries.delete(entries.keys().next().value ?? '');
      entries.delete(id);
      entries.set(id, { status: parsed.data, expiresAt });
    },
    apply(config: PrivateMergedConfig, identity: string): PrivateMergedConfig {
      const context = config.contexts.get(config.currentContext), userName = context?.value.user;
      const user = userName ? config.users.get(userName) : undefined;
      if (!user || !Object.hasOwn(user.value, 'exec')) return config;
      purge();
      const entry = entries.get(key(identity, config.currentContext));
      if (!entry) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
      entries.delete(key(identity, config.currentContext));
      entries.set(key(identity, config.currentContext), entry);
      const input = execAuthenticationInput(config), status = entry.status;
      const value: Record<string, unknown> = {
        ...(status.token ? { token: status.token } : {}),
        ...(status.clientCertificateData ? { 'client-certificate-data': Buffer.from(status.clientCertificateData).toString('base64'), 'client-key-data': Buffer.from(status.clientKeyData ?? '').toString('base64') } : {}),
      };
      const users = new Map(config.users);
      users.set(input.userName, { sourcePath: input.user.sourcePath, value });
      return { ...config, users };
    },
    invalidate(identity: string, context: string) { entries.delete(key(identity, context)); },
    reject(config: PrivateMergedConfig, identity: string) {
      // A late 401 for an older credential must not evict a freshly renewed credential.
      const entry = entries.get(key(identity, config.currentContext));
      const context = config.contexts.get(config.currentContext), user = config.users.get(context?.value.user ?? '');
      if (!entry || !user) return;
      const status = entry.status;
      if (user.value.token === status.token
        && user.value['client-certificate-data'] === (status.clientCertificateData ? Buffer.from(status.clientCertificateData).toString('base64') : undefined)
        && user.value['client-key-data'] === (status.clientKeyData ? Buffer.from(status.clientKeyData).toString('base64') : undefined)) {
        entries.delete(key(identity, config.currentContext));
      }
    },
    clear() { entries.clear(); },
  };
}
