import { z } from 'zod';

const milliseconds = z.number().finite().nonnegative();
export const compileSampleSchema = z.object({
  compileMs: milliseconds, assetsMs: milliseconds, validationMs: milliseconds, manifestMs: milliseconds,
  processPeakRssBytes: z.number().int().nonnegative(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const workerReportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compile'), samples: z.array(compileSampleSchema).min(1).max(9) }).strict(),
  z.object({ kind: z.literal('typecheck'), samplesMs: z.array(milliseconds).min(1).max(9), controllerPeakRssBytes: z.number().int().nonnegative(), freshNativeProcessesPerSample: z.literal(4) }).strict(),
]);

export function summarizeSamples(samples: readonly number[]) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid benchmark samples');
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle] ?? 0 : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
  return { samples: [...samples], minimum: ordered[0], median, maximum: ordered.at(-1) };
}
