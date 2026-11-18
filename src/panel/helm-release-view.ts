import { mountButton, mountSelect, mountTextField } from './controls.ts';
import type { HelmWriteState } from '../host/helm-write-client.ts';
import type { HelmReleaseState } from '../host/helm-release-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { mountOperationSummary, phaseLabel } from './presentation.ts';
import { renderInspectionText } from './inspection-text.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { bindScene } from './workspace-scene.ts';

export function mountHelmReleaseView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), fields = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('p'), output = document.createElement('pre'), record = document.createElement('p');
  section.setAttribute('aria-label', 'Helm releases'); section.className = 'oc-k8s-helm-release-panel';
  actions.className = 'configuration-actions'; fields.className = 'oc-k8s-panel-fields'; status.setAttribute('role', 'status'); output.tabIndex = 0;
  section.append(note, fields, actions, status, output, record); container.append(section);
  let state: HelmReleaseState = { phase: 'idle', stale: false }, namespace = 'default', writeState: HelmWriteState = { phase: 'idle', history: [] };
  let action: 'view' | 'rollback' | 'uninstall' | 'install' = 'view', release = '', chart = '', version = '', revision = '1', rendered = '';
  const writeSummary = mountOperationSummary(document, section, record, locale);
  const slot = () => { const element = document.createElement('div'); fields.append(element); return element; };
  const modeSlot = slot(), namespaceSlot = slot(), releaseSlot = slot(), chartSlot = slot(), versionSlot = slot(), revisionSlot = slot();
  const namespaces = mountSelect(namespaceSlot, { label: 'Namespace', value: namespace, options: [{ id: 'default', label: 'default' }], onChange: value => { namespace = value; paint(); } });
  const actionField = mountSelect(modeSlot, { label: 'Task', value: action, options: [], onChange: value => {
    if (!['view', 'rollback', 'uninstall', 'install'].includes(value)) return;
    action = value as typeof action; paint();
  } });
  const releaseField = mountTextField(releaseSlot, { label: 'Release', value: '', onChange: value => { release = value; paint(); } });
  const chartField = mountTextField(chartSlot, { label: 'Chart', value: '', onChange: value => { chart = value; paint(); } });
  const versionField = mountTextField(versionSlot, { label: 'Version', value: '', onChange: value => { version = value; } });
  const revisionField = mountTextField(revisionSlot, { label: 'Revision', value: revision, onChange: value => { revision = value; } });
  const readSlot = document.createElement('span'), prepareSlot = document.createElement('span'), submitSlot = document.createElement('span'), cancelSlot = document.createElement('span');
  actions.append(readSlot, prepareSlot, submitSlot, cancelSlot);
  const read = mountButton(readSlot, { label: 'Read releases', onClick: () => { void bridge()?.readHelmReleases(namespace); } });
  const prepareWrite = mountButton(prepareSlot, { label: 'Review change', onClick: () => {
    if (action === 'view') return;
    const newest = (state.releases ?? []).find(entry => entry.name === release)?.revisions[0];
    if (action === 'install') bridge()?.prepareHelmWrite({ action, namespace, release, chart, ...(version ? { chartVersion: version } : {}) });
    else if (newest) bridge()?.prepareHelmWrite(action === 'rollback'
      ? { action, namespace, release, revision: Number(revision) || 1, provenanceUid: newest.uid, provenanceResourceVersion: newest.resourceVersion }
      : { action, namespace, release, provenanceUid: newest.uid, provenanceResourceVersion: newest.resourceVersion });
  } });
  const submitWrite = mountButton(submitSlot, { label: 'Confirm', variant: 'destructive', onClick: () => { void bridge()?.submitHelmWrite(); } });
  const cancelWrite = mountButton(cancelSlot, { label: 'Cancel', variant: 'ghost', onClick: () => bridge()?.cancelHelmWrite() });
  const writeLedger = mountButton(actions, { label: 'Check operation results', variant: 'ghost', onClick: () => { void bridge()?.helmWriteOutcomes(); } });
  bindScene(section, 'helm-release', () => ({ namespace, action, release, chart, version, revision }), value => {
    namespace = value.namespace; action = value.action; release = value.release; chart = value.chart; version = value.version; revision = value.revision; paint();
  });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'loading', busyWrite = writeState.phase === 'preparing' || writeState.phase === 'submitting';
    const confirming = writeState.phase === 'confirm', view = action === 'view';
    note.textContent = view ? (zh ? '查看发布状态、历史和清单。' : 'View release status, history and manifests.')
      : action === 'uninstall' ? (zh ? '卸载会删除此发布管理的资源。请核对集群、命名空间和发布名；结果未知时勿重复提交。' : 'Uninstall deletes resources managed by this release. Verify the cluster, namespace and release; do not repeat an unknown operation.')
        : (zh ? '此操作会修改集群，请先核对发布和目标版本，再确认提交。' : 'This changes the cluster. Review the release and target version before confirming.');
    actionField.update({ label: zh ? '当前任务' : 'Current task', value: action, disabled: busyWrite || confirming, options: [
      { id: 'view', label: zh ? '查看发布' : 'View releases' }, { id: 'install', label: zh ? '安装' : 'Install' },
      { id: 'rollback', label: zh ? '回滚' : 'Rollback' }, { id: 'uninstall', label: zh ? '卸载' : 'Uninstall' },
    ] });
    namespaces.update({ disabled: busy || busyWrite || confirming }); releaseField.update({ disabled: busyWrite || confirming });
    chartField.update({ disabled: busyWrite || confirming }); versionField.update({ disabled: busyWrite || confirming }); revisionField.update({ disabled: busyWrite || confirming });
    releaseSlot.hidden = view; chartSlot.hidden = action !== 'install'; versionSlot.hidden = action !== 'install'; revisionSlot.hidden = action !== 'rollback';
    readSlot.hidden = !view && action === 'install'; prepareSlot.hidden = view || confirming; submitSlot.hidden = !confirming; cancelSlot.hidden = !confirming;
    read.update({ label: zh ? '读取发布列表' : 'Read releases', disabled: busy || busyWrite || confirming });
    prepareWrite.update({ label: zh ? '检查变更' : 'Review change', disabled: busyWrite || !release || (action === 'install' && !chart) || (action !== 'install' && !(state.releases ?? []).some(entry => entry.name === release)) });
    submitWrite.update({ label: action === 'uninstall' ? (zh ? '确认卸载' : 'Confirm uninstall') : action === 'rollback' ? (zh ? '确认回滚' : 'Confirm rollback') : (zh ? '确认安装' : 'Confirm install'), disabled: busyWrite || !confirming });
    cancelWrite.update({ label: zh ? '取消' : 'Cancel', disabled: !confirming }); writeLedger.update({ label: zh ? '查询操作结果' : 'Check operation results', disabled: busyWrite });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${state.namespace ? ` · ${state.namespace}` : ''}${state.truncated ? (zh ? ' · 部分结果' : ' · Partial result') : ''}`;
    const detail = state.detail, releases = state.releases ?? [];
    const text = detail ? `${detail.release} · r${detail.revision.revision} · ${detail.revision.status}\n${detail.revision.chartName} ${detail.revision.chartVersion}${detail.description ? `\n${detail.description}` : ''}${detail.config ? `\n\nValues:\n${detail.config}` : ''}${detail.manifest ? `\n\nManifest:\n${detail.manifest}` : ''}`
      : releases.map(item => `${item.name} · r${item.currentRevision} · ${item.currentStatus} · ${item.revisions[0]?.chartName ?? ''} ${item.revisions[0]?.chartVersion ?? ''}`).join('\n');
    if (text !== rendered) { rendered = text; renderInspectionText(document, output, logDisplayText(text)); }
    output.hidden = !text;
    writeSummary.show(writeState);
    record.textContent = writeState.outcome ? `${writeState.outcome.parameters.action} · ${writeState.outcome.parameters.namespace}/${writeState.outcome.parameters.release} · ${writeState.outcome.phase} · ${writeState.outcome.code ?? ''}` : '';
  }
  return { show(value: HelmReleaseState) { state = value; paint(); }, showWrite(value: HelmWriteState) { writeState = value; paint(); },
    targetAction(options: { readonly action: 'rollback' | 'uninstall' | 'install'; readonly namespace?: string; readonly release?: string; readonly chart?: string; readonly version?: string; readonly revision?: number; readonly uid?: string; readonly resourceVersion?: string }) {
      action = options.action;
      if (options.namespace) { namespace = options.namespace; namespaces.update({ value: namespace, options: [{ id: namespace, label: namespace }] }); }
      if (options.release !== undefined) { release = options.release; releaseField.update({ value: release }); }
      if (options.chart !== undefined) { chart = options.chart; chartField.update({ value: chart }); }
      if (options.version !== undefined) { version = options.version; versionField.update({ value: version }); }
      if (options.revision !== undefined) { revision = String(options.revision); revisionField.update({ value: revision }); }
      if (options.namespace && options.release && options.uid && options.resourceVersion) {
        if (options.action === 'uninstall') bridge()?.prepareHelmWrite({ action: 'uninstall', namespace: options.namespace, release: options.release, provenanceUid: options.uid, provenanceResourceVersion: options.resourceVersion });
        else if (options.action === 'rollback' && options.revision !== undefined) bridge()?.prepareHelmWrite({ action: 'rollback', namespace: options.namespace, release: options.release, revision: options.revision, provenanceUid: options.uid, provenanceResourceVersion: options.resourceVersion });
      }
      paint();
    }, paint, dispose() { for (const control of [namespaces, read, actionField, releaseField, chartField, versionField, revisionField, prepareWrite, submitWrite, cancelWrite, writeLedger]) control.dispose(); section.remove(); } };
}
