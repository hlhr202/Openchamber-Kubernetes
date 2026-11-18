import { parseDocument } from 'yaml';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { hasWellFormedUnicode } from '../../shared/identity.ts';
import { helmRepositoryName } from '../../shared/helm-repository-protocol.ts';
import { compareHelmStableVersions, helmSearchVersion } from './helm-search-version.ts';
import type { HelmStableRank } from './helm-search-version.ts';

function parse(content: string, maximumBytes: number): unknown {
  if (Buffer.byteLength(content) > maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  try {
    if (!hasWellFormedUnicode(content)) throw new BoundaryError('CONTENT_INVALID');
    const document = parseDocument(content, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new BoundaryError('CONTENT_INVALID');
    const value: unknown = document.toJS({ maxAliasCount: 0 }); let nodes = 0;
    const visit = (item: unknown, depth: number) => {
      if (++nodes > 200_000 || depth > 32) throw new BoundaryError('BUDGET_EXCEEDED');
      if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
    };
    visit(value, 0); return value;
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONTENT_INVALID'); }
}
export function projectHelmRepositories(content: string): readonly string[] {
  const result = z.object({ apiVersion: z.literal('v1').optional(), repositories: z.array(z.object({ name: helmRepositoryName })).max(64) }).safeParse(parse(content, 1_000_000));
  if (!result.success || new Set(result.data.repositories.map(item => item.name)).size !== result.data.repositories.length) throw new BoundaryError('CONTENT_INVALID');
  return Object.freeze(result.data.repositories.map(item => item.name)); // URL/username/password/cert/key/cache paths NEVER leave this boundary.
}
const metadata = z.object({ name: helmRepositoryName, version: z.string().min(1).max(256).refine(hasWellFormedUnicode), appVersion: z.string().max(1024).default(''), description: z.string().max(8192).default('') });
export type HelmCachedVersion = { readonly version: string; readonly appVersion: string; readonly description: string };
export type HelmCachedChart = { readonly name: string; readonly versions: readonly HelmCachedVersion[] };
export function projectHelmIndex(content: string): readonly HelmCachedChart[] {
  const value = z.object({ apiVersion: z.literal('v1'), entries: z.record(helmRepositoryName, z.array(metadata).max(2000)).nullable().default({}) }).safeParse(parse(content, 8_000_000));
  if (!value.success) throw new BoundaryError('CONTENT_INVALID');
  const entries = Object.entries(value.data.entries ?? {}); if (entries.length > 5000) throw new BoundaryError('BUDGET_EXCEEDED');
  let total = 0; const charts: HelmCachedChart[] = [];
  for (const [name, versions] of entries) {
    if ((total += versions.length) > 20_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const seen = new Set<string>(), admitted: Array<{ value: HelmCachedVersion; rank: HelmStableRank }> = [];
    for (const row of versions) {
      if (row.name !== name || seen.has(row.version) || !hasWellFormedUnicode(row.appVersion) || !hasWellFormedUnicode(row.description)) throw new BoundaryError('CONTENT_INVALID');
      // Like search applyConstraint, an invalid/out-of-uint64 version is skipped, not a whole-index failure.
      // Structural/size/Unicode/duplicate identity errors above still fail the complete file.
      seen.add(row.version); const rank = helmSearchVersion(row.version); if (rank) admitted.push({ value: { version: row.version, appVersion: row.appVersion, description: row.description }, rank });
    }
    admitted.sort((left, right) => compareHelmStableVersions(left.rank, right.rank));
    if (admitted.length) charts.push(Object.freeze({ name, versions: Object.freeze(admitted.map(row => Object.freeze(row.value))) }));
  }
  return Object.freeze(charts.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
