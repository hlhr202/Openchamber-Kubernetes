// Runtime composition only. Authentication may refresh external cloud caches.
// Functional tests may inspect the pure cache/flight model, NEVER invoke this executor, even mocked.
import { dirname, isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { PrivateMergedConfig } from '../queries/kubeconfig.ts';
import { createAuthenticationCache, execAuthenticationInput } from '../queries/authentication-cache.ts';
import { createCredentialFlightState } from '../queries/credential-flight.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import { executeCredentialPlugin } from './exec-credential.ts';

// Non-secret path/config selectors only. Never spread process.env or forward the service bearer.
export function authenticationEnvironment(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ['HOME', 'PATH', 'CLOUDSDK_CONFIG', 'CLOUDSDK_ACTIVE_CONFIG_NAME', 'XDG_CONFIG_HOME', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    const value = input[name];
    if (value !== undefined && value.length <= 8192 && !value.includes('\0')) output[name] = value;
  }
  return output;
}

async function clusterInfo(value: Record<string, unknown>, signal: AbortSignal) {
  const result = { ...value };
  if (typeof result['certificate-authority'] === 'string' && !result['certificate-authority-data']) {
    const file = await open(result['certificate-authority'], constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 131_072n) throw new BoundaryError('BUDGET_EXCEEDED');
      const bytes = Buffer.alloc(131_073);
      try {
        let count = 0;
        while (count < bytes.length) {
          if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          const read = await file.read(bytes, count, bytes.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (count > 131_072) throw new BoundaryError('BUDGET_EXCEEDED');
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new BoundaryError('CONFIG_CHANGED');
        result['certificate-authority-data'] = bytes.subarray(0, count).toString('base64');
      } finally { bytes.fill(0); }
    } finally { await file.close(); }
  }
  delete result['certificate-authority'];
  if (JSON.stringify(result).length > 98_304) throw new BoundaryError('BUDGET_EXCEEDED'); // Stay below Linux's per-env-string ceiling.
  return result;
}

export function createAutomaticCredentials(environment: Readonly<Record<string, string>>) {
  const cache = createAuthenticationCache(), flights = createCredentialFlightState();
  const jobs = new Map<number, { controller: AbortController; promise: Promise<void> }>();
  const failures = new Map<string, { until: number; error: BoundaryError }>();
  return {
    async resolve(config: PrivateMergedConfig, identity: string, signal?: AbortSignal, target?: TargetIdentity): Promise<PrivateMergedConfig> {
      if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const current = config.contexts.get(config.currentContext), user = config.users.get(current?.value.user ?? '');
      if (!user || !Object.hasOwn(user.value, 'exec')) return config;
      if (!target || target.configIdentity !== identity) throw new BoundaryError('STALE_TARGET');
      const { spec, userName, user: located } = execAuthenticationInput(config);
      // Validate URL, target context/namespace and static credential policy BEFORE running any program.
      const users = new Map(config.users);
      users.set(userName, { sourcePath: located.sourcePath, value: {} });
      const bytes = privateKubectlConfiguration({ ...config, users }, target);
      let cluster: Record<string, unknown>;
      try { cluster = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { clusters: { cluster: Record<string, unknown> }[] }).clusters[0]?.cluster ?? {}; }
      finally { bytes.fill(0); }
      if (cache.has(identity, config.currentContext)) return cache.apply(config, identity);
      const key = JSON.stringify([identity, config.currentContext]);
      for (const [id, failure] of failures) if (failure.until <= Date.now()) failures.delete(id);
      const failure = failures.get(key);
      if (failure) throw failure.error; // No tight failure loop across sibling queries.
      const lease = flights.join(key);
      let job = jobs.get(lease.ticket);
      if (lease.created) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
        const promise = Promise.resolve().then(async () => {
          if (!flights.usable(lease.ticket)) throw new BoundaryError('QUERY_CANCELLED');
          const path = isAbsolute(spec.command) ? `${dirname(spec.command)}:${environment.PATH ?? ''}` : environment.PATH ?? '';
          const info = spec.provideClusterInfo ? await clusterInfo(cluster, controller.signal) : undefined;
          const result = await executeCredentialPlugin(spec, controller.signal,
            { ...environment, PATH: path, KUBECONFIG: config.sources.join(':') }, info);
          if (controller.signal.aborted || !flights.usable(lease.ticket)) throw new BoundaryError('QUERY_CANCELLED');
          cache.put(identity, config.currentContext, result.status, result.expiresAt);
        }).catch((error: unknown) => {
          const safe = timedOut ? new BoundaryError('QUERY_TIMEOUT') : error instanceof BoundaryError ? error : new BoundaryError('AUTHENTICATION_UNAVAILABLE');
          if (flights.usable(lease.ticket) && !controller.signal.aborted && safe.code !== 'QUERY_CANCELLED') {
            if (failures.size >= 8) failures.delete(failures.keys().next().value ?? '');
            failures.set(key, { until: Date.now() + 5000, error: safe });
          }
          throw safe;
        }).finally(() => { clearTimeout(timer); jobs.delete(lease.ticket); flights.settle(lease.ticket); });
        job = { controller, promise };
        jobs.set(lease.ticket, job);
      }
      if (!job) throw new BoundaryError('STATE_UNAVAILABLE');
      const owned = job;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          if (flights.leave(lease.ticket, lease.consumer)) owned.controller.abort();
          reject(new BoundaryError('QUERY_CANCELLED'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        void owned.promise.then(resolve, reject).finally(() => { signal?.removeEventListener('abort', abort); flights.leave(lease.ticket, lease.consumer); });
        if (signal?.aborted) abort();
      });
      if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED');
      return cache.apply(config, identity);
    },
    reject: cache.reject,
    close() {
      for (const ticket of flights.close()) jobs.get(ticket)?.controller.abort();
      cache.clear(); failures.clear();
    },
  };
}
