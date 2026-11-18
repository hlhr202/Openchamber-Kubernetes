// Pure G4 submit-gate values only. Never import/call the stateful ledger in operations/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { g4Phases, g4ViewGrantSchema, g4ProofSchema, g4ViewLifetimeMs, g4ConfirmationLifetimeMs, g4LedgerRetentionMs, g4Limits, g4ValidTransition, g4PruneDue, g4ConfirmationExpired, g4OutcomeBaseSchema } from '../../src/shared/g4-submit-protocol.ts';
import type { G4Phase } from '../../src/shared/g4-submit-protocol.ts';
import type { ErrorCode } from '../../src/shared/errors.ts';

const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const base = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'scale-request', dependencies: [] as readonly string[], createdAt: 1_000, updatedAt: 1_000 };
const outcome = (phase: G4Phase, code?: ErrorCode) => ({ ...base, phase, ...(code === undefined ? {} : { code }) });
test('gate timings and limits stay pinned: 120s view, 60s confirmation, 1h ledger, fixed concurrency', () => {
  assert.equal(g4ViewLifetimeMs, 120_000);
  assert.equal(g4ConfirmationLifetimeMs, 60_000);
  assert.equal(g4LedgerRetentionMs, 3_600_000);
  assert.deepEqual(g4Limits, { opening: 2, preparing: 2, running: 2, views: 64, records: 128, queued: 16, outcomePage: 16 });
  assert.ok(Object.isFrozen(g4Limits));
});
test('view grants are exactly uuid id + 32-byte hex capability + service generation + expiry', () => {
  assert.equal(g4ViewGrantSchema.safeParse(grant).success, true);
  for (const bad of [{ ...grant, capability: 'A'.repeat(64) }, { ...grant, capability: 'a'.repeat(63) }, { ...grant, serviceGeneration: 'service' }, { ...grant, expiresAt: -1 }, { ...grant, extra: 1 }]) assert.equal(g4ViewGrantSchema.safeParse(bad).success, false);
  assert.equal(g4ProofSchema.safeParse('b'.repeat(64)).success, true);
  assert.equal(g4ProofSchema.safeParse('b'.repeat(65)).success, false);
});
test('phase set matches the audited G4 chain and outcomes are metadata-only', () => {
  assert.deepEqual([...g4Phases], ['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']);
  assert.equal(g4OutcomeBaseSchema.safeParse({ ...base, phase: 'prepared' }).success, true);
  assert.equal(g4OutcomeBaseSchema.safeParse({ ...base, phase: 'done' }).success, false);
  for (const extra of [{ text: 'x' }, { body: '{}' }, { argv: ['kubectl'] }]) assert.equal(g4OutcomeBaseSchema.safeParse({ ...base, phase: 'prepared', ...extra }).success, false);
});
test('pure transition rule: accepted never carries a code; cancelled always explains itself', () => {
  assert.equal(g4ValidTransition(outcome('accepted')), true);
  assert.equal(g4ValidTransition(outcome('accepted', 'NOT_FOUND')), false);
  assert.equal(g4ValidTransition(outcome('failed', 'NOT_FOUND')), true);
  assert.equal(g4ValidTransition(outcome('cancelled', 'QUERY_CANCELLED')), true);
  assert.equal(g4ValidTransition(outcome('cancelled')), false);
  assert.equal(g4ValidTransition({ ...outcome('failed', 'NOT_FOUND'), updatedAt: 999 }), false);
});
test('prune rule: only finished determinate records age out; unknown blocks the ledger forever', () => {
  const now = 4_600_000;
  assert.equal(g4PruneDue(outcome('accepted'), now), true); // updatedAt 1000 + 3_600_000 <= now
  assert.equal(g4PruneDue(outcome('failed', 'CONFLICT'), now), true);
  assert.equal(g4PruneDue(outcome('cancelled', 'QUERY_CANCELLED'), now), true);
  assert.equal(g4PruneDue(outcome('unknown', 'OPERATION_UNKNOWN'), now), false);
  assert.equal(g4PruneDue(outcome('prepared'), now), false);
  assert.equal(g4PruneDue({ ...outcome('accepted'), updatedAt: now }, now), false);
});
test('confirmation expiry applies only to still-prepared records past their 60s window', () => {
  assert.equal(g4ConfirmationExpired(outcome('prepared'), 61_001, 61_001), true);
  assert.equal(g4ConfirmationExpired(outcome('prepared'), 60_001, 60_000), false);
  assert.equal(g4ConfirmationExpired(outcome('queued'), 61_001, 61_001), false);
  assert.equal(g4ConfirmationExpired(outcome('cancelled', 'QUERY_CANCELLED'), 61_001, 61_001), false);
});
