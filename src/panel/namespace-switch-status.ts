import type { NamespaceSwitchState } from '../host/namespace-client.ts';
import { setText } from './presentation-update.ts';
import { panelText } from './i18n.ts';
import type { PanelLocale } from './i18n.ts';

// Presentation only: writing the file and reloading the view are separate facts.
export function paintNamespaceSwitchStatus(status: HTMLElement, value: NamespaceSwitchState, language: PanelLocale | boolean): void {
  const locale = typeof language === 'boolean' ? (language ? 'zh-CN' : 'en') : language;
  const hidden = value.phase === 'idle';
  if (status.hidden !== hidden) status.hidden = hidden;
  const error = value.phase === 'error' ? value.written
    ? panelText(locale, 'namespace.reloadFailed', value.namespace, value.error)
    : value.error === 'OPERATION_UNKNOWN'
      ? panelText(locale, 'namespace.unknown', value.namespace)
      : panelText(locale, 'namespace.failed', value.namespace, value.error) : '';
  setText(status, value.phase === 'switching' ? panelText(locale, 'namespace.switching', value.namespace)
    : value.phase === 'reloading' ? panelText(locale, 'namespace.reloading', value.namespace) : error);
}
