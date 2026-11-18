import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import { hasWellFormedUnicode } from './identity.ts';

// Upstream helmVersion: probe the syntax version (v2 answers `version --short -c`; v3/v4 answer
// `version --short`), then print `version` (v2 uses `-c`). The upstream GLOBAL syntax cache is a
// documented deviation here: every read re-probes, so an executable or config change can never
// reuse a stale global syntax (the upstream STALE case itself demands this).
export const helmSyntaxSchema = z.enum(['v2', 'v3', 'v4', 'unknown']);
export type HelmSyntax = z.infer<typeof helmSyntaxSchema>;
const output = z.string().min(1).max(4096).refine(value => hasWellFormedUnicode(value) && !value.includes('\0'));
export const helmVersionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read') }).strict(),
]);
export type HelmVersionRequest = z.infer<typeof helmVersionRequestSchema>;
export type HelmVersionProbe = { readonly code: number; readonly stdout: string };
export const helmVersionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-version'), syntax: helmSyntaxSchema, output }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-version-unavailable'), syntax: z.literal('unknown'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmVersionResponse = z.infer<typeof helmVersionResponseSchema>;
// Pure syntax classification following the pinned probe order.
export function classifyHelmSyntax(probeV2: HelmVersionProbe | undefined, probeModern: HelmVersionProbe | undefined): 'v2' | 'v3' | 'v4' | 'unknown' {
  if (probeV2 && probeV2.code === 0 && probeV2.stdout.includes('v2')) return 'v2';
  if (probeModern && probeModern.code === 0) {
    if (probeModern.stdout.includes('v4')) return 'v4';
    if (probeModern.stdout.includes('v3')) return 'v3';
  }
  return 'unknown';
}
// The final display invocation per pinned upstream: v2 keeps the -c client flag, v3/v4 add none.
export function helmVersionArguments(syntax: 'v2' | 'v3' | 'v4' | 'unknown'): readonly string[] {
  return syntax === 'v2' ? ['version', '-c'] : ['version'];
}
// Pure final projection: a classified syntax, a zero exit and non-empty output; fixed codes, never CLI stderr.
export function projectHelmVersion(probeV2: { code: number; stdout: string } | undefined, probeModern: { code: number; stdout: string } | undefined, display: { code: number; stdout: string } | undefined): { syntax: HelmSyntax; output: string } {
  const syntax = classifyHelmSyntax(probeV2, probeModern);
  if (syntax === 'unknown' || !display || display.code !== 0 || !display.stdout.trim()) throw new BoundaryError('CLI_INCOMPATIBLE');
  return { syntax, output: display.stdout.trim() };
}
