import { BoundaryError } from '../../shared/errors.ts';
import { readTarget } from '../../shared/identity.ts';
import type { ConfigRead } from './config-page.ts';

// projectId remains a correlation partition, NOT host-authenticated owner identity.
// The selected configuration is re-read by the future route/adapter before calling this.
export function bindResourceTarget(value: unknown, configuration: ConfigRead, serviceGeneration: string) {
  const target = readTarget(value);
  if (target.serviceGeneration !== serviceGeneration || target.configIdentity !== configuration.snapshot.configIdentity) throw new BoundaryError('STALE_TARGET');
  if (configuration.status !== 'ready' || configuration.snapshot.currentContextMissing) throw new BoundaryError('CONFIG_REFERENCE_MISSING');
  const context = configuration.snapshot.contexts.find(item => item.name === target.context);
  if (!context || !context.available) throw new BoundaryError('CONFIG_REFERENCE_MISSING');
  // Other contexts/namespaces require M4's real configuration switch, never a silent read-side override.
  if (!context.active || context.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
  return target;
}
