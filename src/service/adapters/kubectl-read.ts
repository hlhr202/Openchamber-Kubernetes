import { BoundaryError } from '../../shared/errors.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import { validateKubectlReadRequest, validateResourceReadTransportRequest } from '../queries/kubectl-plan.ts';
import type { ReadResponse } from '../queries/bounded-response.ts';
import type { ResourceReadRequest } from '../queries/resource-reader.ts';
import { readThroughWorker } from './read-worker-client.ts';
import { tryMetadataList } from './metadata-list-https.ts';

export function createKubectlReadAdapter(config: ReturnType<typeof createConfigReader>, executablePath: string, entry: URL) {
  // No executable lookup, authentication, directory creation or process on construction.
  return async (selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal): Promise<ReadResponse> => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    // Only the already validated route and query cross the legacy worker boundary.
    const { representation, customList: _customList, ...cliRequest } = request;
    validateResourceReadTransportRequest(request);
    if (!representation && !executablePath) throw new BoundaryError('CLI_NOT_FOUND');
    const configuration = await config.transportRead(selection, request.target.configIdentity, signal, request.target);
    const input = privateKubectlConfiguration(configuration.merged, request.target); // Exec resolves on demand before the worker; only static credentials cross IPC.
    try {
      if (representation) {
        const result = await tryMetadataList(request, input, signal);
        if (result) {
          if (result.status === 401) config.credentialsRejected(configuration.merged, request.target.configIdentity);
          return result;
        }
      }
      if (!executablePath) throw new BoundaryError('CLI_NOT_FOUND');
      if (representation) validateKubectlReadRequest(cliRequest);
      const result = await readThroughWorker(entry, { protocol: 1, kind: 'read', request: cliRequest, snapshot: input, path: executablePath }, signal);
      if (result.status === 401) config.credentialsRejected(configuration.merged, request.target.configIdentity);
      return { status: result.status, ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}), body: { async *[Symbol.asyncIterator]() { yield result.body; } }, close: async () => {} };
    } catch (error) {
      if (error instanceof BoundaryError && error.code === 'UNAUTHENTICATED') config.credentialsRejected(configuration.merged, request.target.configIdentity);
      if (error instanceof BoundaryError) throw error;
      throw new BoundaryError('STATE_UNAVAILABLE');
    } finally { input.fill(0); } // Best effort only, not OS/GC secure erasure.
  };
}
