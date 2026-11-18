// Pure lifecycle decisions only: no bridge/SDK, auth, workers, writes or streams.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostSnapshotLifecycle } from '../../src/host/host-snapshot-lifecycle.ts';
import { phaseLabel } from '../../src/panel/presentation.ts';

test('repeat ready and replayed directory snapshots initialize once, even for the null project', () => {
  for (const directory of [null, '/synthetic/project']) {
    const lifecycle = new HostSnapshotLifecycle();
    assert.deepEqual(lifecycle.ready(directory), { initialize: true, projectChanged: true });
    for (let index = 0; index < 200; index++) {
      assert.deepEqual(lifecycle.ready(directory), { initialize: false, projectChanged: false });
      assert.equal(lifecycle.directory(directory), false);
    }
  }
});
test('directory-first delivery is deduplicated when ready arrives; A→B→A is a real change each time', () => {
  const lifecycle = new HostSnapshotLifecycle();
  assert.equal(lifecycle.directory('/synthetic/a'), true);
  assert.deepEqual(lifecycle.ready('/synthetic/a'), { initialize: true, projectChanged: false });
  assert.equal(lifecycle.directory('/synthetic/b'), true);
  assert.deepEqual(lifecycle.ready('/synthetic/b'), { initialize: false, projectChanged: false });
  assert.deepEqual(lifecycle.ready('/synthetic/a'), { initialize: false, projectChanged: true });
  assert.equal(lifecycle.directory(null), true);
  assert.equal(lifecycle.directory(null), false);
});
test('session identity, busy, title, model, locale and theme do not enter the data lifecycle identity', () => {
  const lifecycle = new HostSnapshotLifecycle();
  let initializations = 0, configurationReads = 0, resets = 0;
  for (let index = 0; index < 500; index++) {
    const snapshot = { directory: '/synthetic/a', session: { id: `session-${index}`, busy: index % 2 === 0 }, theme: index % 2 ? 'dark' : 'light', locale: index % 2 ? 'zh' : 'en' };
    const update = lifecycle.ready(snapshot.directory);
    if (update.initialize) initializations++;
    if (update.projectChanged) { resets++; configurationReads++; }
    if (lifecycle.directory(snapshot.directory)) { resets++; configurationReads++; }
  }
  assert.deepEqual({ initializations, configurationReads, resets }, { initializations: 1, configurationReads: 1, resets: 1 });
});
test('operation labels distinguish accepted, succeeded and unknown without exposing internal phase tokens', () => {
  assert.notEqual(phaseLabel('accepted', true), phaseLabel('succeeded', true));
  assert.match(phaseLabel('unknown', true), /未知.*勿重复提交/);
  assert.match(phaseLabel('unknown', false), /do not resubmit/);
  assert.equal(phaseLabel('ready', true), '已加载');
  assert.equal(phaseLabel('internal-new-phase', true), '处理中');
});
