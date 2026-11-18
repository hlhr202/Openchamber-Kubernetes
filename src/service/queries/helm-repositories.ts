import { createHmac, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { helmRepositoryPageSchema, helmRepositoryRequestSchema } from '../../shared/helm-repository-protocol.ts';
import type { HelmRepositoryNode, HelmRepositoryPage, HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
import { projectHelmIndex, projectHelmRepositories } from './helm-repository-source.ts';
import { ReadScheduler } from './read-scheduler.ts';
export type HelmRepositoryFileRead = (path: string, maximumBytes: number, signal: AbortSignal) => Promise<{ readonly content: string; readonly version: string } | null>;
export function createHelmRepositoryReader(serviceGeneration: string, readFile: HelmRepositoryFileRead, defaults?: () => HelmRepositorySource) {
  const key = randomBytes(32), scheduler = new ReadScheduler<HelmRepositoryPage>({ concurrency: 2, queued: 8, consumers: 32, timeoutMs: 5000 });
  const identity = (value: unknown) => `helm-${createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')}`;
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  return {
    async read(input: unknown, signal: AbortSignal): Promise<HelmRepositoryPage> {
      const parsed = helmRepositoryRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
      if (request.binding.serviceGeneration !== serviceGeneration) throw new BoundaryError('STALE_TARGET');
      const source: HelmRepositorySource = 'mode' in request.binding.selection ? (() => { if (!defaults) throw new BoundaryError('INVALID_INPUT'); return defaults(); })()
        : { paths: request.binding.selection, origins: { repositoryFile: 'explicit', indexDirectory: 'explicit' } };
      const { repositoryFile, indexDirectory } = source.paths;
      if (posix.normalize(repositoryFile) !== repositoryFile || posix.normalize(indexDirectory) !== indexDirectory) throw new BoundaryError('INVALID_INPUT');
      return scheduler.run([JSON.stringify(request), JSON.stringify(source)], async sharedSignal => {
        const config = await readFile(repositoryFile, 1_000_000, sharedSignal); if (!config) throw new BoundaryError('CONFIG_NOT_FOUND');
        if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        const repositories = projectHelmRepositories(config.content), configurationId = identity([request.binding, source.paths, config]);
        if (request.branch.kind !== 'repositories' && (request.branch.configurationId !== configurationId || !repositories.includes(request.branch.repository))) throw new BoundaryError('STALE_TARGET');
        let indexId: string | null = null, nodes: HelmRepositoryNode[];
        if (request.branch.kind === 'repositories') nodes = repositories.map(repository => ({ kind: 'repository', repository, label: repository, id: identity([configurationId, repository]) }));
        else {
          const branch = request.branch, index = await readFile(posix.join(indexDirectory, `${branch.repository}-index.yaml`), 8_000_000, sharedSignal);
          if (!index) throw new BoundaryError('HELM_INDEX_MISSING');
          if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          indexId = identity([configurationId, branch.repository, index]); const charts = projectHelmIndex(index.content);
          if (branch.kind === 'versions' && branch.indexId !== indexId) throw new BoundaryError('STALE_TARGET');
          if (branch.kind === 'charts') nodes = charts.map(chart => ({ kind: 'chart', repository: branch.repository, chart: chart.name, label: chart.name, id: identity([indexId, chart.name]) }));
          else {
            const chart = charts.find(chart => chart.name === branch.chart); if (!chart) throw new BoundaryError('NOT_FOUND');
            nodes = chart.versions.map(row => ({ kind: 'version', repository: branch.repository, chart: branch.chart, label: row.version, ...row,
              tooltip: `${row.description || 'No description available'}${row.appVersion ? `\nApp version: ${row.appVersion}` : ''}`, id: identity([indexId, branch.chart, row.version]) }));
          }
        }
        const snapshotId = indexId ?? configurationId;
        if (request.snapshotId !== undefined && request.snapshotId !== snapshotId || request.offset > nodes.length) throw new BoundaryError('STALE_TARGET');
        const after = await readFile(repositoryFile, 1_000_000, sharedSignal);
        if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        if (!after || identity([request.binding, source.paths, after]) !== configurationId) throw new BoundaryError('STALE_TARGET');
        const end = Math.min(nodes.length, request.offset + 100), response = helmRepositoryPageSchema.parse({ protocol: 2, kind: 'helm-repositories', binding: request.binding, branch: request.branch,
          resolvedSelection: source.paths, sourceOrigins: source.origins, configurationId, indexId, snapshotId, offset: request.offset, total: nodes.length, nextOffset: end < nodes.length ? end : null, nodes: nodes.slice(request.offset, end), versionPolicy: 'helm-v3.19.0-semver-v3.4.0-stable-gt-zero', provenance: 'filename-only-unverified-origin' });
        if (Buffer.byteLength(JSON.stringify(response)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freeze(response); return response;
      }, { signal });
    },
    close: () => scheduler.close(),
  };
}
