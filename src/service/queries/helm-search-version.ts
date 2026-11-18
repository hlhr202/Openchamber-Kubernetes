// Source contract: Helm 3.19.0 search >0.0.0 and Masterminds/semver 3.4.0
// NewVersion with its default CoerceNewVersion=true. Not an arbitrary constraint engine.
const uint64Maximum = 18_446_744_073_709_551_615n;
export type HelmStableRank = readonly [bigint, bigint, bigint];
export function helmSearchVersion(version: string): HelmStableRank | null {
  // Projector/DTO budget, checked here too so the pure helper cannot parse unbounded input.
  if (version.length === 0 || version.length > 256) return null;
  const parsed = /^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  // JS $ also accepts before a final newline; Go's anchored expression does not.
  if (!parsed || parsed[0] !== version) return null;
  const rank: HelmStableRank = [BigInt(parsed[1] ?? '0'), BigInt(parsed[2] ?? '0'), BigInt(parsed[3] ?? '0')];
  if (rank.some(value => value > uint64Maximum)) return null;
  // The fixed search constraint excludes ALL prereleases, including coerced partial ones.
  // Malformed numeric prerelease identifiers are rejected by NewVersion, and are excluded here too.
  if (parsed[4] !== undefined || rank.every(value => value === 0n)) return null;
  return Object.freeze(rank);
}
export function compareHelmStableVersions(left: HelmStableRank, right: HelmStableRank): number {
  for (const index of [0, 1, 2] as const) if (left[index] !== right[index]) return left[index] > right[index] ? -1 : 1;
  return 0; // Build metadata/v prefix/coerced spelling have no SemVer precedence.
}
