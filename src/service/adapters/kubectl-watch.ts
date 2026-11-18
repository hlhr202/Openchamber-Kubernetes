import { BoundaryError } from '../../shared/errors.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import { validateKubectlReadRequest } from '../queries/kubectl-plan.ts';
import { requireReadSuccess } from '../queries/resource-query.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { WatchTransport } from '../queries/watch-runner.ts';
import { readThroughWorker } from './read-worker-client.ts';

export function createKubectlWatchAdapter(config: ReturnType<typeof createConfigReader>, path: string, entry: URL): WatchTransport {
  return async (selection, request, signal, emit) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    if (!path) throw new BoundaryError('CLI_NOT_FOUND');
    if (request.purpose !== 'resource-watch' && request.purpose !== 'custom-resource-watch' && request.purpose !== 'pod-log-follow' && request.purpose !== 'namespace-event-watch' && request.purpose !== 'job-pod-watch') throw new BoundaryError('INVALID_INPUT'); validateKubectlReadRequest(request);
    const configuration = await config.transportRead(selection, request.target.configIdentity, signal, request.target), input = privateKubectlConfiguration(configuration.merged, request.target);
    try { const result = await readThroughWorker(entry, { protocol: 1, kind: 'read', request, snapshot: input, path }, signal, emit); requireReadSuccess(result.status); }
    catch (error) {
      if (error instanceof BoundaryError && error.code === 'UNAUTHENTICATED') config.credentialsRejected(configuration.merged, request.target.configIdentity);
      throw error;
    }
    finally { input.fill(0); }
  };
}
