import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { CronJobRunState } from '../host/cronjob-run-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
export function mountCronJobRunView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Run CronJob now'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: CronJobRunState = { phase: 'idle', history: [] }, reference: DocumentReference | undefined, jobName = '';
  const origin = mountTextField(actions, { label: 'CronJob namespace/name (from selected row)', value: '', onChange: () => {} });
  const input = mountTextField(actions, { label: 'Job name (default name-timestamp, editable)', value: '', onChange: value => { jobName = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Run Now (fresh proof + limited confirmation)', onClick: () => { if (reference) void bridge()?.prepareCronJobRun(reference, jobName); } });
  const submit = mountButton(actions, { label: 'Confirm exact-origin Run Now (single Job POST)', onClick: () => { void bridge()?.submitCronJobRun(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelCronJobRun() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.cronJobRunOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.cronJobRunOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '立即创建一个 Job，不改变定时计划。请核对任务名；结果未知时不要重复运行。' : 'Create a Job now without changing the schedule. Check the job name; do not repeat an operation with an unknown outcome.';
    origin.update({ label: zh ? 'CronJob namespace/name' : 'CronJob namespace/name', disabled: true });
    input.update({ label: zh ? 'job名（默认name-时间戳，可改）' : 'Job name (default name-timestamp, editable)', disabled: busy });
    prepare.update({ label: zh ? '检查运行任务' : 'Review Job', disabled: busy || !reference });
    submit.update({ label: zh ? '确认立即运行' : 'Confirm running now', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${reference ? `\ncronjob ${reference.namespace ?? ''}/${reference.name}` : ''}${value ? `\njob ${value.parameters.jobName} · ${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'cronjob-run', () => ({ reference, jobName }), value => { reference = value.reference; jobName = value.jobName; paint(); });
  return { show(value: CronJobRunState) { state = value; paint(); }, target(ref: DocumentReference | undefined) {
    reference = ref; origin.update({ value: ref ? `${ref.namespace ?? ''}/${ref.name}` : '' }); paint();
  }, paint, dispose() { for (const control of [origin, input, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
