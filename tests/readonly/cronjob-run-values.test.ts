// Pure protocol/input values only. Never import/call any real or mock CronJob Run client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cronJobRunParametersSchema, cronJobRunRequestSchema, cronJobRunResponseSchema, cronJobRunOutcomeSchema, proposedJobName, jobNameSchema } from '../../src/shared/cronjob-run-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const reference = { type: { group: 'batch', version: 'v1', resource: 'cronjobs', kind: 'CronJob', scope: 'namespace' as const }, name: 'nightly', namespace: 'default', uid: 'cron-uid', resourceVersion: '9' };
const parameters = { reference, jobName: 'nightly-20260101000000' };
const outcome = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'cronjob-run-now' as const, dependencies: [] as const, target, parameters, createdAt: 1, updatedAt: 1, phase: 'prepared' as const };
test('parameters admit only batch/v1 namespaced CronJob references with an explicit DNS job name', () => {
  assert.equal(cronJobRunParametersSchema.safeParse(parameters).success, true);
  for (const bad of [
    { ...parameters, reference: { ...reference, type: { ...reference.type, resource: 'jobs', kind: 'Job' } } },
    { ...parameters, reference: { ...reference, type: { ...reference.type, group: 'example.io' } } },
    { ...parameters, reference: { ...reference, namespace: undefined } }, // original namespace only, never the global target
    { ...parameters, jobName: 'Bad_Name' }, { ...parameters, jobName: '' }, { ...parameters, jobName: '-leading' }, { ...parameters, jobName: 'a'.repeat(254) },
  ]) assert.equal(cronJobRunParametersSchema.safeParse(bad).success === false, true, JSON.stringify(bad).slice(0, 80));
});
test('job name proposal mirrors the upstream name-timestamp default from a local editable clock', () => {
  const value = proposedJobName('nightly', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  assert.equal(value, 'nightly-20260102030405'); assert.equal(jobNameSchema.safeParse(value).success, true);
  assert.equal(proposedJobName('nightly', new Date(Date.UTC(2026, 10, 20, 23, 59, 59))), 'nightly-20261120235959'); // month/day zero-padded
});
test('request union carries its own grant/confirmation and never a CLI argv, cronjob body or path', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome.id, proof: 'b'.repeat(64), confirmation: 'cronjob-run-now-exact-origin' };
  assert.equal(cronJobRunRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['create', 'job'] }, { path: '/apis/batch/v1' }, { body: '{}' }, { from: 'cronjob/nightly' }, { confirmation: 'scale-exact-target-replicas' }]) assert.equal(cronJobRunRequestSchema.safeParse({ ...submit, ...extra }).success, false);
  assert.equal(cronJobRunRequestSchema.safeParse({ protocol: 2, kind: 'prepare', grant, parameters }).success, true);
});
test('outcome ledger is metadata-only and accepted results cannot claim an error code', () => {
  const response = (value: unknown) => cronJobRunResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome), true);
  assert.equal(cronJobRunOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome, phase: 'accepted' }), true);
  assert.equal(response({ ...outcome, phase: 'unknown', code: 'OPERATION_UNKNOWN' }), true);
  for (const extra of [{ body: 'x' }, { jobTemplate: {} }, { argv: [] }]) assert.equal(cronJobRunOutcomeSchema.safeParse({ ...outcome, ...extra }).success, false);
});
