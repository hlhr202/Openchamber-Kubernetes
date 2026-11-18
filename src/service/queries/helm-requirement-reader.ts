// READ-ONLY requirement lookup over the same repository-file boundary and pure projections the
// repository explorer uses. No CLI, no subprocess, no writes, no automatic insertion anywhere.
import { posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { helmRequirementRequestSchema, requirementText } from '../../shared/helm-requirement-protocol.ts';
import type { HelmRequirementResponse } from '../../shared/helm-requirement-protocol.ts';
import { projectHelmIndex, projectHelmRepositories } from './helm-repository-source.ts';
import type { HelmRepositoryFileRead } from './helm-repositories.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
import { ReadScheduler } from './read-scheduler.ts';
export function createHelmRequirementReader(readFile: HelmRepositoryFileRead, defaults?: () => HelmRepositorySource) {
  const scheduler = new ReadScheduler<HelmRequirementResponse>({ concurrency: 2, queued: 8, consumers: 32, timeoutMs: 5000 });
  return {
    async read(input: unknown, signal: AbortSignal): Promise<HelmRequirementResponse> {
      const parsed = helmRequirementRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const { repository, chart } = parsed.data;
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const result = await scheduler.run([repository, chart], async sharedSignal => {
        if (!defaults) throw new BoundaryError('INVALID_INPUT');
        const { repositoryFile, indexDirectory } = defaults().paths;
        if (posix.normalize(repositoryFile) !== repositoryFile || posix.normalize(indexDirectory) !== indexDirectory) throw new BoundaryError('INVALID_INPUT');
        const config = await readFile(repositoryFile, 1_000_000, sharedSignal); if (!config) throw new BoundaryError('CONFIG_NOT_FOUND');
        if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        if (!projectHelmRepositories(config.content).includes(repository)) throw new BoundaryError('NOT_FOUND');
        const index = await readFile(posix.join(indexDirectory, `${repository}-index.yaml`), 8_000_000, sharedSignal); if (!index) throw new BoundaryError('HELM_INDEX_MISSING');
        if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        const entry = projectHelmIndex(index.content).find(item => item.name === chart); if (!entry) throw new BoundaryError('NOT_FOUND');
        // The projection sorts newest-first; upstream takes releases[0].version from the index.
        const version = entry.versions[0]?.version; if (!version) throw new BoundaryError('CONTENT_INVALID');
        return Object.freeze({ protocol: 2 as const, kind: 'helm-requirement' as const, repository, chart, version, text: requirementText(repository, chart, version) });
      }, { signal });
      return result;
    },
    close() { scheduler.close(); },
  };
}
