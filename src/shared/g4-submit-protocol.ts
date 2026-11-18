import { z } from 'zod';
import { errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';

// Common G4 submit-gate wire values shared by every WRITE chain (view grant -> limited
// confirmation -> single dispatch -> original ledger). The stateful ledger lives in
// src/service/operations/g4-submit.ts; this module holds only portable constants, schemas
// and pure helpers so read-only suites can verify them without importing executors.
export const g4Phases = ['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled'] as const;
export type G4Phase = typeof g4Phases[number];
// Fixed gate timings: a view grant lives at most 120s, a confirmation 60s, a finished
// ledger entry 1h. Unknown records are NEVER evicted to admit another submission.
export const g4ViewLifetimeMs = 120_000;
export const g4ConfirmationLifetimeMs = 60_000;
export const g4LedgerRetentionMs = 3_600_000;
export const g4Limits = Object.freeze({
  opening: 2, preparing: 2, running: 2, // concurrent gate work per operation kind
  views: 64, records: 128, queued: 16, // retained intent shapes
  outcomePage: 16, // one ledger page
});
export const g4ViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type G4ViewGrant = z.infer<typeof g4ViewGrantSchema>;
export const g4ProofSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const g4OutcomeBaseSchema = z.object({
  id: z.string().uuid(), owner: z.string().uuid(), step: z.string().min(1).max(64), dependencies: z.array(z.string().min(1).max(64)).max(8),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(g4Phases), code: z.enum(errorCodes).optional(),
}).strict();
export type G4OutcomeBase = z.infer<typeof g4OutcomeBaseSchema>;
// Pure transition rule shared by every ledger: accepted never carries a failure code, and
// a submit attempt whose phase is no longer 'prepared' can only be an explicit conflict.
export function g4ValidTransition(outcome: { readonly phase: G4Phase; readonly code?: ErrorCode | undefined; readonly createdAt: number; readonly updatedAt: number }): boolean {
  if (outcome.phase === 'accepted' && outcome.code !== undefined) return false;
  if (outcome.phase === 'cancelled' && outcome.code === undefined) return false;
  if (['accepted', 'failed', 'unknown', 'cancelled'].includes(outcome.phase) && outcome.updatedAt < outcome.createdAt) return false;
  return true;
}
// Ledger retention: finished records with a determinate outcome may age out; unknown never.
export function g4PruneDue(outcome: { readonly phase: G4Phase; readonly updatedAt: number }, now: number): boolean {
  if (outcome.phase === 'unknown') return false;
  return ['accepted', 'failed', 'cancelled'].includes(outcome.phase) && outcome.updatedAt + g4LedgerRetentionMs <= now;
}
// Confirmation windows: prepared work past its 60s deadline cancels with CONFIRMATION_EXPIRED.
export function g4ConfirmationExpired(outcome: { readonly phase: G4Phase }, expiresAt: number, now: number): boolean {
  return outcome.phase === 'prepared' && expiresAt <= now;
}
