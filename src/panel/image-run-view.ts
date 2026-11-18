import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ImageRunState } from '../host/image-run-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountImageRunView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Run image'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ImageRunState = { phase: 'idle', history: [] }, user = '', version = '';
  const userField = mountTextField(actions, { label: 'Image user (optional, vsdocker.imageUser)', value: '', onChange: value => { user = value; } });
  const versionField = mountTextField(actions, { label: 'Version (required tag)', value: '', onChange: value => { version = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Run (pin root/version/image)', onClick: () => { void bridge()?.prepareImageRun(user || undefined, version); } });
  const submit = mountButton(actions, { label: 'Confirm exact build+push+run (single dispatch)', onClick: () => { void bridge()?.submitImageRun(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelImageRun() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.imageRunOutcomes(); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '构建并推送镜像，然后在集群创建 Pod。失败即停止，但已推送镜像或已创建资源不会自动撤销。' : 'Build and push an image, then create a Pod. Failure stops the sequence without undoing an image push or created resources.';
    prepare.update({ label: zh ? '检查镜像与目标' : 'Review image & target', disabled: busy || !version });
    submit.update({ label: zh ? '确认构建、推送并运行' : 'Confirm build, push & run', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${value ? `\n${value.parameters.image} · ${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''}${value?.built !== undefined ? `\nbuilt ${value.built} · pushed ${value.pushed ?? false}${value.podUid ? ` · pod ${value.podUid}` : ''}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'image-run', () => ({ user, version }), value => { user = value.user; version = value.version; paint(); });
  return { show(value: ImageRunState) { state = value; paint(); }, paint, dispose() { for (const control of [userField, versionField, prepare, submit, cancel, ledger]) control.dispose(); section.remove(); } };
}
