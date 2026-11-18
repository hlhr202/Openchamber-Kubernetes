import { mountButton, mountSelect, mountTextField } from './controls.ts';
import type { PodLogState } from '../host/pod-log-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { mountLogTextView } from './log-text-view.ts';
import { mountLogFollowView } from './log-follow-view.ts';
import type { LogFollowState } from '../host/log-follow-client.ts';
import { defaultLogPreferences, LogOpenDefaults, logPreferenceNumber, logOptionsFromPreferences } from '../shared/log-preferences.ts';
import type { LogPreferences } from '../shared/log-preferences.ts';
import type { LogPreferenceState } from '../host/log-preference-reader.ts';
import { mountLogTerminalView } from './log-terminal-view.ts';
import { isLogDurationUnit, logDurationSeconds, splitLogDuration } from '../shared/log-duration.ts';
import type { LogDurationUnit } from '../shared/log-duration.ts';
import { disclosure, phaseLabel } from './presentation.ts';
import { bindScene, isSceneRestoring } from './workspace-scene.ts';

export function mountPodLogView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), title = document.createElement('p'), note = document.createElement('p'), status = document.createElement('p');
  const fields = document.createElement('div'), selectSlot = document.createElement('div'), sinceSlot = document.createElement('div'), sinceUnitSlot = document.createElement('div'), tailSlot = document.createElement('div'), actions = document.createElement('div');
  const timeLabel = document.createElement('label'), timeText = document.createElement('span'), timestamps = document.createElement('input'); timestamps.type = 'checkbox'; timeLabel.append(timestamps, timeText);
  const output = document.createElement('div'); output.className = 'configuration-results';
  actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); fields.append(selectSlot, sinceSlot, sinceUnitSlot, tailSlot, timeLabel); section.append(title, note, fields, actions, status, output); container.append(section);
  section.className = 'oc-k8s-log-panel'; title.className = 'oc-k8s-panel-target'; fields.className = 'oc-k8s-log-controls';
  note.className = 'oc-k8s-panel-note';
  const settings = disclosure(document, section, 'Log preferences'), settingsActions = document.createElement('div');
  settingsActions.className = 'configuration-actions'; settings.body.append(settingsActions);
  let state: PodLogState = { phase: 'idle', stale: false, text: '', complete: false, containers: [] }, selected = '', since = '', tail = '';
  let sinceUnit: LogDurationUnit = 's';
  let preference: LogPreferenceState = { phase: 'idle', settings: defaultLogPreferences }, saving = false, saveUnknown = false, resolvingUnknown = false, disposed = false, settingsRevision = 0, saveStatus = '', uiError = '', wrapEnabled = false, destination: LogPreferences['destination'] = 'Webview';
  const defaults = new LogOpenDefaults(), settingStatus = document.createElement('p'); settingStatus.setAttribute('role', 'status'); settings.body.append(settingStatus);
  let following = false;
  const followLabel = document.createElement('label'), followText = document.createElement('span'), followEnabled = document.createElement('input'); followEnabled.type = 'checkbox'; followLabel.append(followEnabled, followText);
  const autoLabel = document.createElement('label'), autoText = document.createElement('span'), autorun = document.createElement('input'); autorun.type = 'checkbox'; autoLabel.append(autorun, autoText);
  const wrapLabel = document.createElement('label'), wrapText = document.createElement('span'), wrapCheck = document.createElement('input'); wrapCheck.type = 'checkbox'; wrapLabel.append(wrapCheck, wrapText);
  const destinationSlot = document.createElement('div'); settings.body.prepend(followLabel, autoLabel, destinationSlot);
  const touched = () => { defaults.touch(); settingsRevision++; saveStatus = ''; uiError = ''; };
  const wrapChanged = (value: boolean) => { touched(); wrapEnabled = value; wrapCheck.checked = value; paint(); };
  const follow = mountLogFollowView(document, section, bridge, locale, () => wrapEnabled, wrapChanged, () => destination === 'Terminal');
  const viewer = mountLogTextView(document, output, locale, text => bridge()?.copyLogPage(text) ?? Promise.reject(new Error('HOST_UNAVAILABLE')), wrapChanged);
  const terminalSlot = document.createElement('div'); section.append(terminalSlot); const terminal = mountLogTerminalView(document, terminalSlot, locale);
  const changed = () => { touched(); bridge()?.stopLogFollow(); bridge()?.clearPodLog(); };
  const select = mountSelect(selectSlot, { label: 'Container', value: '', options: [], onChange: value => { selected = value; select.update({ value }); changed(); } });
  const sinceField = mountTextField(sinceSlot, { label: 'Since duration (blank: no filter)', value: '', onChange: value => { since = value; sinceField.update({ value }); changed(); } });
  const sinceUnits = mountSelect(sinceUnitSlot, { label: 'Since unit', value: sinceUnit, options: [], onChange: value => { if (isLogDurationUnit(value)) { sinceUnit = value; sinceUnits.update({ value }); changed(); } } });
  const tailField = mountTextField(tailSlot, { label: 'Tail lines (blank: no filter)', value: '', onChange: value => { tail = value; tailField.update({ value }); changed(); } });
  const timestampChanged = changed; timestamps.addEventListener('change', timestampChanged);
  followEnabled.addEventListener('change', changed); autorun.addEventListener('change', touched);
  const wrapCheckChanged = () => wrapChanged(wrapCheck.checked); wrapCheck.addEventListener('change', wrapCheckChanged);
  const destinationField = mountSelect(destinationSlot, { label: 'Destination', value: destination, options: [{ id: 'Webview', label: 'Webview' }, { id: 'Terminal', label: 'Terminal (read-only logs)' }], onChange: value => { if (value === 'Webview' || value === 'Terminal') { destination = value; destinationField.update({ value }); changed(); } } });
  const draft = (): LogPreferences => ({ version: 1, follow: followEnabled.checked, timestamp: timestamps.checked, wrap: wrapEnabled, autorun: autorun.checked,
    since: logDurationSeconds(since, sinceUnit), tail: logPreferenceNumber(tail, 1_000_000), destination });
  const runConfigured = (stream = followEnabled.checked) => {
    touched();
    try { const options = logOptionsFromPreferences(draft());
      if (stream) void bridge()?.runLogFollow(selected, options); else { bridge()?.stopLogFollow(); void bridge()?.runPodLog(selected, options); }
    } catch { uiError = 'INVALID_INPUT'; paint(); }
  };
  const run = mountButton(actions, { label: 'Read logs', disabled: true, onClick: () => runConfigured(false) });
  const runFollow = mountButton(actions, { label: 'Follow logs', disabled: true, onClick: () => runConfigured(true) });
  const applySettings = (settings: Readonly<LogPreferences>) => {
    followEnabled.checked = settings.follow; timestamps.checked = settings.timestamp; autorun.checked = settings.autorun; wrapEnabled = settings.wrap; wrapCheck.checked = settings.wrap; destination = settings.destination;
    const duration = splitLogDuration(settings.since); since = duration.value; sinceUnit = duration.unit; tail = settings.tail === -1 ? '' : String(settings.tail);
    sinceField.update({ value: since }); sinceUnits.update({ value: sinceUnit }); tailField.update({ value: tail }); destinationField.update({ value: destination }); selected = state.containers[0]?.name ?? '';
  };
  const save = mountButton(settingsActions, { label: 'Save preferences', variant: 'outline', onClick: () => {
    if (saving || saveUnknown || disposed) return; let value: LogPreferences;
    touched(); // Explicit Save consumes any pending open-time defaults/autorun decision, but does not execute a read.
    try { value = draft(); } catch { uiError = 'INVALID_INPUT'; paint(); return; }
    const host = bridge(); if (!host) { uiError = 'HOST_UNAVAILABLE'; paint(); return; }
    saving = true; const revision = settingsRevision; saveStatus = ''; paint();
    void host.saveLogPreferences(value).then(result => {
      saving = false; if (disposed) return; saveUnknown = result === 'unknown'; saveStatus = result === 'saved' ? revision === settingsRevision ? 'SAVED' : 'SAVED_PREVIOUS_DRAFT' : result === 'unknown' ? 'SAVE_UNKNOWN_NO_RETRY' : result === 'busy' ? 'QUERY_LIMIT' : 'INVALID_INPUT';
      if (result === 'saved') void host.readLogPreferences(); paint();
    });
  } });
  const readSettings = mountButton(settingsActions, { label: 'Reload saved settings', variant: 'outline', onClick: () => { touched(); resolvingUnknown = saveUnknown; void bridge()?.readLogPreferences(); } });
  const resetSettings = mountButton(settingsActions, { label: 'Reset settings', variant: 'outline', onClick: () => {
    if (preference.phase !== 'ready') { uiError = 'SETTINGS_NOT_READY'; paint(); return; }
    touched(); bridge()?.stopLogFollow(); bridge()?.clearPodLog(); applySettings(preference.settings); paint(); // Reset never autoruns.
  } });
  const nextSlot = document.createElement('span'), cancelSlot = document.createElement('span'); actions.append(nextSlot, cancelSlot);
  const next = mountButton(nextSlot, { label: 'Load more', disabled: true, variant: 'outline', onClick: () => { void bridge()?.nextPodLog(); } });
  const cancel = mountButton(cancelSlot, { label: 'Stop loading', disabled: true, variant: 'ghost', onClick: () => bridge()?.cancelPodLog() });
  const clear = mountButton(actions, { label: 'Clear output', variant: 'ghost', onClick: () => { touched(); bridge()?.clearPodLog(); } });
  const close = mountButton(actions, { label: 'Close logs', variant: 'ghost', onClick: () => bridge()?.closePodLog() });
  function paint() {
    if (disposed) return;
    const initial = defaults.take(preference.phase === 'ready' && state.phase === 'ready' && !state.stale, state.containers.length, preference.settings);
    if (initial) { applySettings(initial.settings);
      if (initial.autorun && !isSceneRestoring(document)) queueMicrotask(() => { if (!disposed && !isSceneRestoring(document) && defaults.revision === initial.revision && !defaults.touched && state.phase === 'ready' && !state.stale) runConfigured(); });
    }
    follow.paint();
    const zh = locale().startsWith('zh'), loading = state.phase === 'loading', source = state.source;
    section.hidden = state.phase === 'idle'; section.setAttribute('aria-label', zh ? 'Pod 日志有限快照' : 'Pod log finite snapshot'); section.setAttribute('aria-busy', String(loading));
    title.textContent = source ? `${source.target.context} / ${source.origin ? `Job ${source.origin.name} → ` : ''}${source.reference.namespace} / ${source.reference.name}${state.page ? ` / ${state.page.container}` : ''}` : '';
    title.title = source ? `core/v1 Pod · UID ${source.reference.uid} · RV ${source.reference.resourceVersion}${source.origin ? ` · batch/v1 Job UID ${source.origin.uid} · RV ${source.origin.resourceVersion}` : ''}` : '';
    note.textContent = '';
    note.hidden = true;
    settings.summary.textContent = zh ? '日志偏好设置' : 'Log preferences';
    select.update({ label: zh ? '容器' : 'Container', value: selected, disabled: loading, options: state.containers.map(value => ({ id: value.name, label: `${value.name}${value.kind === 'init' ? ' (init)' : ''}` })) });
    sinceField.update({ label: zh ? '最近时长（空：不筛选）' : 'Since duration (blank: no filter)', disabled: loading });
    sinceUnits.update({ label: zh ? '时长单位' : 'Since unit', value: sinceUnit, disabled: loading, options: [{ id: 's', label: zh ? '秒' : 'Second(s)' }, { id: 'm', label: zh ? '分' : 'Minute(s)' }, { id: 'h', label: zh ? '小时' : 'Hour(s)' }] });
    tailField.update({ label: zh ? '末尾行数（空：不筛选）' : 'Tail lines (blank: no filter)', disabled: loading });
    timeText.textContent = zh ? '时间戳' : 'Timestamps'; timestamps.disabled = loading;
    followText.textContent = zh ? '自动运行时跟随日志' : 'Follow when autorun is enabled'; autoText.textContent = zh ? '下次打开自动读取（保存后生效）' : 'Read automatically on next open (save to enable)'; wrapText.textContent = zh ? '换行' : 'Wrap'; followEnabled.disabled = loading;
    destinationField.update({ label: zh ? '输出位置' : 'Destination', value: destination, disabled: loading, options: [{ id: 'Webview', label: 'Webview' }, { id: 'Terminal', label: zh ? 'Terminal（只读日志）' : 'Terminal (read-only logs)' }] });
    run.update({ label: zh ? '读取日志' : 'Read logs', disabled: loading || state.stale || !state.containers.length }); next.update({ label: zh ? '继续读取' : 'Load more', disabled: state.phase !== 'ready' || !state.page?.nextCursor });
    nextSlot.hidden = !state.page?.nextCursor || following; cancelSlot.hidden = !loading;
    runFollow.update({ label: zh ? '开始跟随' : 'Start following', disabled: following || state.phase !== 'ready' || state.stale || !state.containers.length });
    save.update({ label: zh ? '保存偏好' : 'Save preferences', disabled: saving || saveUnknown }); resetSettings.update({ label: zh ? '恢复已存设置' : 'Restore saved settings', disabled: preference.phase !== 'ready' }); readSettings.update({ label: zh ? '重新读取偏好' : 'Reload preferences', disabled: saving || preference.phase === 'loading' });
    settingStatus.textContent = saveUnknown ? (zh ? '保存结果未知，请重新读取偏好核对，勿重复保存。' : 'Save outcome unknown. Reload preferences to check; do not save again.')
      : saving ? (zh ? '正在保存…' : 'Saving…') : saveStatus === 'SAVED' ? (zh ? '偏好已保存' : 'Preferences saved')
        : saveStatus === 'SAVED_PREVIOUS_DRAFT' ? (zh ? '上次提交的设置已保存，当前修改尚未保存。' : 'Previous draft saved; current changes are not saved.')
          : preference.error || uiError || (saveStatus && saveStatus !== 'SAVED' ? saveStatus : '');
    settingStatus.hidden = !settingStatus.textContent;
    if (saveUnknown || uiError || preference.error) settings.element.open = true;
    if (uiError) status.textContent = uiError;
    cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading }); clear.update({ label: zh ? '清除输出' : 'Clear output' }); close.update({ label: zh ? '关闭日志' : 'Close logs' });
    status.textContent = state.phase === 'error' ? `${state.error ?? 'STATE_UNAVAILABLE'}${state.stale ? (zh ? '（过期输出）' : ' (stale output)') : ''}` : loading ? (zh ? '正在读取…' : 'Reading…')
      : state.page ? `${state.complete ? (zh ? '已加载全部日志' : 'All logs loaded') : (zh ? '已加载部分日志' : 'Partial logs loaded')} · ${new Intl.NumberFormat(zh ? 'zh-CN' : 'en', { maximumFractionDigits: 1 }).format(state.page.totalBytes / 1024)} KB` : (zh ? '选择容器后读取或跟随日志。' : 'Select a container, then read or follow logs.');
    if (uiError) status.textContent = `${phaseLabel('error', zh)} · ${uiError}`;
    status.hidden = following && !uiError;
    viewer.show(state.text, source ? JSON.stringify([source.target, source.reference, source.origin, state.page?.snapshotId ?? '']) : '');
    viewer.setWrap(wrapEnabled);
    output.hidden = destination === 'Terminal' || following; terminalSlot.hidden = following;
    terminal.setEnabled(destination === 'Terminal' && state.phase !== 'idle' && !following); terminal.snapshot(state);
  }
  bindScene(section, 'pod-log-options', () => ({ selected, since, sinceUnit, tail, saveUnknown, resolvingUnknown, settingsRevision, saveStatus, uiError, wrapEnabled, destination }), value => {
    selected = value.selected; since = value.since; sinceUnit = value.sinceUnit; tail = value.tail; saveUnknown = value.saveUnknown;
    resolvingUnknown = value.resolvingUnknown; settingsRevision = value.settingsRevision; saveStatus = value.saveStatus; uiError = value.uiError;
    wrapEnabled = value.wrapEnabled; destination = value.destination; defaults.touch(); paint();
  });
  return { show(value: PodLogState) {
    if (value.phase === 'idle') { defaults.reset(); settingsRevision++; selected = ''; since = ''; sinceUnit = 's'; tail = ''; timestamps.checked = false; followEnabled.checked = false; autorun.checked = false; wrapEnabled = false; wrapCheck.checked = false; destination = 'Webview'; uiError = ''; saveStatus = ''; sinceField.update({ value: '' }); sinceUnits.update({ value: sinceUnit }); tailField.update({ value: '' }); }
    if (!value.containers.some(item => item.name === selected)) selected = value.containers[0]?.name ?? '';
    state = value; paint();
  }, showPreferences(value: LogPreferenceState) { preference = value; if (resolvingUnknown && value.phase === 'ready') { saveUnknown = false; resolvingUnknown = false; } if (value.phase === 'error') resolvingUnknown = false; paint(); }, showFollow(value: LogFollowState) { following = value.phase !== 'idle'; follow.show(value); paint(); }, paint, dispose() { disposed = true; defaults.reset(); terminal.dispose(); viewer.dispose(); follow.dispose(); runFollow.dispose(); state = { phase: 'idle', stale: false, text: '', complete: false, containers: [] }; selected = ''; since = ''; tail = ''; timestamps.removeEventListener('change', timestampChanged); followEnabled.removeEventListener('change', changed); autorun.removeEventListener('change', touched); wrapCheck.removeEventListener('change', wrapCheckChanged); readSettings.dispose(); save.dispose(); resetSettings.dispose(); destinationField.dispose(); select.dispose(); sinceField.dispose(); sinceUnits.dispose(); tailField.dispose(); run.dispose(); next.dispose(); cancel.dispose(); clear.dispose(); close.dispose(); section.remove(); } };
}
