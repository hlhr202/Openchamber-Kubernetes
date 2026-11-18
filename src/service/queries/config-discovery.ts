import { posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { readConfigSelection } from '../../shared/configuration.ts';
import { containsControlCharacters, utf8ByteLength } from '../../shared/identity.ts';

export type DefaultConfigPaths = string | readonly string[];
export function defaultConfigPaths(value: DefaultConfigPaths): readonly string[] {
  const paths = typeof value === 'string' ? [value] : [...value];
  if (paths.length > 64 || paths.reduce((sum, path) => sum + utf8ByteLength(path), 0) > 24_000) throw new BoundaryError('BUDGET_EXCEEDED');
  for (const path of paths) readConfigSelection({ mode: 'file', path });
  return Object.freeze([...new Set(paths)]);
}

// Pure, injected startup inputs only. No process.env/cwd, HOME scan, file lookup, authentication or migration.
// Official 2.5.1 does NOT forward Server KUBECONFIG: callers must not imply that it does.
export function discoverDefaultConfig(input: { readonly home: string; readonly cwd: string; readonly kubeconfig?: string }) {
  if (!posix.isAbsolute(input.home) || !posix.isAbsolute(input.cwd) || [input.home, input.cwd].some(value => containsControlCharacters(value) || value.includes('\\') || value.startsWith('//'))) throw new BoundaryError('INVALID_INPUT');
  const value = input.kubeconfig;
  if (value === undefined || value === '') return Object.freeze({ basis: 'home' as const, paths: defaultConfigPaths(posix.join(input.home, '.kube', 'config')) });
  if (utf8ByteLength(value) > 24_000) throw new BoundaryError('BUDGET_EXCEEDED');
  if (containsControlCharacters(value) || value.includes('\\')) throw new BoundaryError('INVALID_INPUT');
  const parts = value.split(':').filter(path => path !== '');
  if (parts.length > 64) throw new BoundaryError('BUDGET_EXCEEDED');
  if (parts.some(path => path.startsWith('//'))) throw new BoundaryError('INVALID_INPUT');
  // Empty entries are ignored, never cwd; ':' intentionally yields no files and does NOT fall back to HOME.
  return Object.freeze({ basis: 'service-kubeconfig' as const, paths: defaultConfigPaths(parts.map(path => posix.resolve(input.cwd, path))) });
}
