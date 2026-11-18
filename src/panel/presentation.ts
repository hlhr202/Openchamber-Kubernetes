import { panelLocale, panelText } from './i18n.ts';
import type { PanelMessage } from './i18n.ts';

const phases: Readonly<Record<string, readonly [string, string]>> = {
  idle: ['尚未开始', 'Not started'], loading: ['正在读取…', 'Loading…'], ready: ['已加载', 'Loaded'],
  error: ['操作失败', 'Failed'], preparing: ['正在准备…', 'Preparing…'], prepared: ['待确认', 'Awaiting confirmation'],
  confirm: ['请核对并确认', 'Review and confirm'], submitting: ['正在提交，请勿重复操作…', 'Submitting; do not repeat…'],
  submitted: ['已提交', 'Submitted'], polling: ['正在查询原操作…', 'Checking original operation…'],
  result: ['操作结果', 'Result'], succeeded: ['已成功', 'Succeeded'], failed: ['已失败', 'Failed'],
  unknown: ['结果未知，请查询原操作；勿重复提交', 'Outcome unknown; check the original operation, do not resubmit'],
  cancelled: ['已取消', 'Cancelled'], expired: ['已过期，请重新准备', 'Expired; prepare again'],
  opening: ['正在连接…', 'Connecting…'], starting: ['正在启动…', 'Starting…'], running: ['运行中', 'Running'],
  stopped: ['已停止', 'Stopped'], closed: ['已关闭', 'Closed'], detached: ['已断开显示', 'Detached'],
  uploading: ['正在上传…', 'Uploading…'], reading: ['正在读取…', 'Reading…'], listing: ['正在列出…', 'Listing…'],
  openingRoot: ['正在打开目录…', 'Opening directory…'], openingFile: ['正在打开文件…', 'Opening file…'],
  accepted: ['已受理，尚未确认完成', 'Accepted; completion not yet confirmed'], unchanged: ['无需更改', 'No changes'],
  initial: ['请先核对目标与风险', 'Review the target and risks'], queued: ['已排队，请勿重复提交', 'Queued; do not resubmit'],
  dispatching: ['正在执行，请勿重复提交…', 'Executing; do not resubmit…'],
};
export function phaseLabel(phase: string, zh: boolean): string {
  return phases[phase]?.[zh ? 0 : 1] ?? (zh ? '处理中' : 'In progress');
}

const operationPhases: ReadonlyMap<string, PanelMessage> = new Map([
  ['confirm', 'operation.review'], ['submitting', 'operation.submitting'],
  ['unknown', 'operation.unknown'], ['failed', 'operation.failed'], ['error', 'operation.failed'],
  ['succeeded', 'operation.succeeded'], ['cancelled', 'operation.cancelled'],
  ['accepted', 'operation.accepted'], ['expired', 'operation.expired'], ['unchanged', 'operation.unchanged'],
]);

// Native details is intentionally not repainted or reconstructed. Each mounted
// view owns its disclosure state, which survives host snapshots and task switches.
export function disclosure(document: Document, parent: HTMLElement, label: string): { element: HTMLDetailsElement; body: HTMLElement; summary: HTMLElement } {
  const element = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div');
  element.className = 'oc-k8s-disclosure'; summary.textContent = label; body.className = 'oc-k8s-disclosure-body';
  element.append(summary, body); parent.append(element);
  return { element, body, summary };
}

export function mountOperationSummary(document: Document, section: HTMLElement, technical: HTMLElement, locale: () => string) {
  const summary = document.createElement('div'), target = document.createElement('p'), status = document.createElement('p'), change = document.createElement('p');
  summary.className = 'oc-k8s-operation-summary'; target.className = 'oc-k8s-panel-target'; status.setAttribute('role', 'status');
  summary.append(target, change, status); section.insertBefore(summary, technical);
  const details = disclosure(document, section, 'Operation identifiers');
  technical.removeAttribute('role'); technical.classList.add('oc-k8s-operation-identifiers'); details.body.append(technical);
  for (const button of section.querySelectorAll<HTMLElement>('[data-operation-action="history"]')) details.body.append(button);
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return { identifiers: details.body, show(state: { phase: string; error?: string; outcome?: unknown; intent?: unknown }) {
    const language = panelLocale(locale()), zh = language.startsWith('zh'), value = record(state.outcome ?? state.intent), scope = record(value.target), reference = record(value.reference), parameters = record(value.parameters);
    const terminal = ['unknown', 'failed', 'cancelled', 'expired', 'succeeded', 'accepted', 'unchanged'];
    const result = text(value.phase), phase = terminal.includes(result) ? result : state.phase;
    section.dataset.operationPhase = state.phase;
    summary.hidden = state.phase === 'idle' && !state.error && !result;
    details.element.hidden = false;
    const code = state.error || text(value.code);
    const phaseMessage = operationPhases.get(phase);
    status.textContent = `${phaseMessage ? panelText(language, phaseMessage) : phaseLabel(phase, zh)}${code ? ` (${code})` : ''}`;
    status.dataset.tone = phase === 'failed' || state.error ? 'error' : phase === 'unknown' || phase === 'expired' ? 'warning' : phase === 'succeeded' ? 'success' : 'info';
    target.textContent = [text(scope.context || value.context), text(reference.namespace || scope.namespace || parameters.namespace), text(reference.name || parameters.release || parameters.image || parameters.commitId), text(scope.root), text(scope.path || value.path)].filter(Boolean).join(' / ');
    if (value.context) target.textContent += `${target.textContent ? ' · ' : ''}${text(value.previous) || '—'} → ${text(value.namespace || value.context)}`;
    const changes: string[] = [];
    if (parameters.replicas !== undefined) changes.push(`${zh ? '目标副本数' : 'Target replicas'}: ${text(parameters.replicas)}`);
    if (parameters.action) changes.push(text(parameters.action));
    if (value.action) changes.push(text(value.action));
    if (parameters.name) changes.push(`${zh ? '名称' : 'Name'}: ${text(parameters.name)}`);
    if (value.missing === true) changes.push(zh ? '对象缺失：此次确认将创建新对象' : 'Object missing: confirmation will create a new object');
    if (parameters.port) changes.push(`${zh ? '端口' : 'Port'}: ${text(parameters.port)} → ${text(parameters.targetPort) || text(parameters.port)}`);
    if (value.expiresAt && !terminal.includes(result)) changes.push(`${zh ? '确认有效至' : 'Confirm before'} ${new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(Number(value.expiresAt))}`);
    if (value.cleanup && !['none', 'clean', 'cleaned', 'not-needed', 'removed'].includes(text(value.cleanup))) changes.push(zh ? '请核对下方清理记录，可能有临时文件残留。' : 'Check the cleanup record below for possible temporary files.');
    change.textContent = changes.join(' · '); change.hidden = !change.textContent; target.hidden = !target.textContent;
    details.summary.textContent = panelText(language, 'operation.records');
  } };
}
