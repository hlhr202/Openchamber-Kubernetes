import { posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from '../../shared/identity.ts';
import { helmRepositoryPathsSchema } from '../../shared/helm-repository-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export type HelmRepositoryEnvironment = {
  readonly home: string; readonly cwd: string; readonly platform: string;
  readonly repositoryConfig?: string | undefined; readonly repositoryCache?: string | undefined;
  readonly configHome?: string | undefined; readonly cacheHome?: string | undefined;
  readonly xdgConfigHome?: string | undefined; readonly xdgCacheHome?: string | undefined;
};
// Pure service-input resolution. No process.env, HOME scan, shell, helm env, filesystem or OS user lookup.
export function discoverHelmRepositories(input: HelmRepositoryEnvironment): HelmRepositorySource {
  if (input.platform !== 'linux' && input.platform !== 'darwin') throw new BoundaryError('CLI_INCOMPATIBLE');
  const valid = (path: string) => path.length > 0 && path.length <= 4096 && !path.startsWith('//') && !path.includes('\\') && !containsControlCharacters(path) && hasWellFormedUnicode(path);
  if (!valid(input.cwd) || !posix.isAbsolute(input.cwd)) throw new BoundaryError('INVALID_INPUT');
  const absolute = (value: string) => { if (!valid(value)) throw new BoundaryError('INVALID_INPUT'); return posix.resolve(input.cwd, value); };
  const origin: HelmRepositorySource['origins'] = {
    repositoryFile: input.repositoryConfig ? 'HELM_REPOSITORY_CONFIG' : input.configHome ? 'HELM_CONFIG_HOME' : input.xdgConfigHome ? 'XDG_CONFIG_HOME' : 'platform-default',
    indexDirectory: input.repositoryCache ? 'HELM_REPOSITORY_CACHE' : input.cacheHome ? 'HELM_CACHE_HOME' : input.xdgCacheHome ? 'XDG_CACHE_HOME' : 'platform-default',
  };
  const home = () => absolute(input.home); // Only validate lower-priority inputs when actually consumed.
  const configBase = () => input.configHome ? absolute(input.configHome) : input.xdgConfigHome ? posix.join(absolute(input.xdgConfigHome), 'helm')
    : posix.join(home(), ...(input.platform === 'darwin' ? ['Library', 'Preferences', 'helm'] : ['.config', 'helm']));
  const cacheBase = () => input.cacheHome ? absolute(input.cacheHome) : input.xdgCacheHome ? posix.join(absolute(input.xdgCacheHome), 'helm')
    : posix.join(home(), ...(input.platform === 'darwin' ? ['Library', 'Caches', 'helm'] : ['.cache', 'helm']));
  const parsed = helmRepositoryPathsSchema.safeParse({ repositoryFile: input.repositoryConfig ? absolute(input.repositoryConfig) : posix.join(configBase(), 'repositories.yaml'),
    indexDirectory: input.repositoryCache ? absolute(input.repositoryCache) : posix.join(cacheBase(), 'repository') });
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  return Object.freeze({ paths: Object.freeze(parsed.data), origins: Object.freeze(origin) });
}
