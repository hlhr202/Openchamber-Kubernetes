import { mountButton } from '@openchamber/sdk/ui';
import { bindScene } from './workspace-scene.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';

export type RequestDiagnosticsBridge = {
  readonly readRequestDiagnostics: () => Promise<unknown>;
};

type DiagnosticsPayload = {
  readonly limits?: {
    readonly concurrency: number;
    readonly tokensPerSecond: number;
    readonly burst: number;
    readonly queued: number;
    readonly timeoutMs: number;
    readonly backgroundMaxSlots: number;
  };
  readonly inFlight?: number;
  readonly inFlightBackground?: number;
  readonly queued?: number;
  readonly tokensAvailable?: number;
  readonly logicalIntents?: number;
  readonly transportCalls?: number;
  readonly observableHttpRequests?: number;
  readonly coalescedLogical?: number;
  readonly queueWaits?: number;
  readonly totalQueueWaitMs?: number;
  readonly totalDurationMs?: number;
  readonly responseBytes?: number;
  readonly cancelledQueued?: number;
  readonly cancelledRunning?: number;
  readonly rejectedLimit?: number;
  readonly rejectedCooldown?: number;
  readonly timedOut?: number;
  readonly rateDelayed?: number;
  readonly status401?: number;
  readonly status403?: number;
  readonly status410?: number;
  readonly status429?: number;
  readonly retryAfterObserved?: number;
  readonly activeCooldowns?: number;
  readonly recent?: readonly {
    readonly kind: string;
    readonly purpose: string;
    readonly priority: string;
    readonly outcome: string;
    readonly status?: number;
    readonly queueWaitMs: number;
    readonly durationMs: number;
    readonly bytes: number;
  }[];
};

// Sanitized outbound cluster request budget & telemetry view (RX-C10 / RX-A17).
// Mounted only on demand via the Request Diagnostics route; never clutters the home screen.
export function mountRequestDiagnosticsView(
  document: Document,
  container: HTMLElement,
  bridge: () => RequestDiagnosticsBridge | undefined,
  locale: () => string,
) {
  const section = document.createElement('section');
  const note = document.createElement('p');
  const actions = document.createElement('div');
  actions.className = 'configuration-actions';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const summary = document.createElement('pre');
  summary.className = 'oc-k8s-diagnostics-summary';
  const list = document.createElement('div');
  list.className = 'configuration-results';

  section.append(note, actions, status, summary, list);
  container.append(section);

  let payload: DiagnosticsPayload | undefined;
  let errorCode: string | undefined;
  let loading = false;

  const refreshBtn = mountButton(actions, {
    label: 'Refresh request diagnostics',
    onClick: () => { void load(); },
  });

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    errorCode = undefined;
    paint();
    try {
      const value = await bridge()?.readRequestDiagnostics();
      payload = (typeof value === 'object' && value !== null ? value : undefined) as DiagnosticsPayload | undefined;
    } catch (error) {
      errorCode = error instanceof Error ? error.message : 'STATE_UNAVAILABLE';
    } finally {
      loading = false;
      paint();
    }
  }

  bindScene(section, 'request-diagnostics', () => ({ errorCode }), value => { errorCode = value.errorCode; loading = false; paint(); });
  function paint(): void {
    const zh = locale().toLowerCase().startsWith('zh');
    note.textContent = zh
      ? '脱敏出站请求预算与遥测（GET /v2/status/requests）。不显示凭证、原始 URL 参数、Secret 或资源正文。'
      : 'Sanitized outbound read budget & telemetry (GET /v2/status/requests). No credentials, raw URL parameters, Secrets, or resource bodies.';
    refreshBtn.update({ label: zh ? '刷新请求诊断' : 'Refresh request diagnostics', disabled: loading });
    status.textContent = loading ? (zh ? '读取中…' : 'Loading…') : errorCode ? `${errorCode}` : payload ? (zh ? '已更新' : 'Updated') : (zh ? '点击刷新读取。' : 'Click refresh to inspect.');

    if (payload) {
      const l = payload.limits;
      const lines = [
        l ? `limits: concurrency=${l.concurrency}, rate=${l.tokensPerSecond}/s, burst=${l.burst}, queue=${l.queued}, timeout=${l.timeoutMs}ms, bgMax=${l.backgroundMaxSlots}` : 'limits: -',
        `inFlight=${payload.inFlight ?? 0} (bg=${payload.inFlightBackground ?? 0}) · queued=${payload.queued ?? 0} · tokens=${payload.tokensAvailable ?? 0}`,
        `logicalIntents=${payload.logicalIntents ?? 0} · coalesced=${payload.coalescedLogical ?? 0} · transportCalls=${payload.transportCalls ?? 0} · observableHTTP=${payload.observableHttpRequests ?? 0}`,
        `queueWaits=${payload.queueWaits ?? 0} (${payload.totalQueueWaitMs ?? 0}ms) · totalDuration=${payload.totalDurationMs ?? 0}ms · responseBytes=${payload.responseBytes ?? 0}`,
        `cancelled: queued=${payload.cancelledQueued ?? 0}, running=${payload.cancelledRunning ?? 0} · rejected: limit=${payload.rejectedLimit ?? 0}, cooldown=${payload.rejectedCooldown ?? 0} · timedOut=${payload.timedOut ?? 0} · rateDelayed=${payload.rateDelayed ?? 0}`,
        `status: 401=${payload.status401 ?? 0}, 403=${payload.status403 ?? 0}, 410=${payload.status410 ?? 0}, 429=${payload.status429 ?? 0} · retryAfterObserved=${payload.retryAfterObserved ?? 0} · activeCooldowns=${payload.activeCooldowns ?? 0}`,
      ];
      summary.textContent = logDisplayText(lines.join('\n'));
      list.replaceChildren();
      for (const item of payload.recent ?? []) {
        const row = document.createElement('p');
        row.textContent = logDisplayText(`${item.priority} · ${item.kind} · ${item.purpose} · ${item.outcome}${item.status !== undefined ? ` (${item.status})` : ''} · wait ${item.queueWaitMs}ms · dur ${item.durationMs}ms · ${item.bytes}B`);
        list.append(row);
      }
    } else {
      summary.textContent = '';
      list.replaceChildren();
    }
  }

  paint();

  return {
    show(value: unknown) { payload = value as DiagnosticsPayload; errorCode = undefined; loading = false; paint(); },
    load,
    paint,
    dispose() {
      refreshBtn.dispose();
      list.replaceChildren();
      section.remove();
    },
  };
}
