import { AsyncLocalStorage } from 'node:async_hooks';
import { createProjectRuntime } from '../../host/bridge.ts';
import type { ProjectRuntimeHost } from '../../shared/project-runtime-host.ts';
import type { WorkspaceEffect } from '../../shared/project-workspace-protocol.ts';
import { workspaceCallbackChannels } from '../../shared/project-workspace-protocol.ts';
import { logPreferenceKey, readLogPreferences } from '../../shared/log-preferences.ts';
import { BoundaryError } from '../../shared/errors.ts';
import type { ProjectWorkspaceRuntime } from '../queries/project-workspaces.ts';

export function createResidentProjectRuntime(options: {
  id: string; directory: string; locale: string; preferences: unknown;
  request: ProjectRuntimeHost['serviceRequest']; emit(channel: string, ...args: unknown[]): void;
}): ProjectWorkspaceRuntime {
  const effects = new AsyncLocalStorage<WorkspaceEffect[]>(), storage = new Map<string, unknown>([[logPreferenceKey, options.preferences]]);
  let ready: Parameters<ProjectRuntimeHost['onReady']>[0] | undefined, locale = options.locale;
  const latest = new Map<string, unknown[]>();
  const emit = (channel: string, ...args: unknown[]) => { latest.set(channel, args); options.emit(channel, ...args); };
  const effect = (value: WorkspaceEffect) => {
    const pending = effects.getStore();
    if (!pending) return Promise.reject(new BoundaryError('STATE_UNAVAILABLE'));
    pending.push(value); return Promise.resolve();
  };
  const host: ProjectRuntimeHost = {
    workspaceId: options.id,
    serviceRequest: options.request,
    onReady(callback) { ready = callback; return () => { ready = undefined; }; },
    onDirectory() { return () => {}; }, // This project's directory never follows a viewer.
    storage: {
      get: async key => storage.get(key),
      set: async () => { throw new BoundaryError('STATE_UNAVAILABLE'); }, // SDK persistence belongs to an explicit live viewer.
    },
    writeClipboard: text => effect({ kind: 'clipboard', text }),
    openUrl: url => effect({ kind: 'open-url', url }),
    dispose() {},
  };
  const callbacks = workspaceCallbackChannels.map(channel => (...args: unknown[]) => emit(channel, ...args));
  // The tuple follows the original explicit callback contract, including the
  // two-argument source-file notification. No browser connection is created.
  type Callbacks = Parameters<typeof createProjectRuntime> extends [unknown, ...infer Rest] ? Rest : never;
  const api = createProjectRuntime(host, ...callbacks as unknown as Callbacks);
  const calls = api as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(calls)) {
    if (!name.startsWith('on') || typeof value !== 'function') continue;
    (value as (callback: (...args: unknown[]) => void) => unknown)((...args) => emit(name, ...args));
  }
  ready?.({ directory: options.directory, locale });
  const selectorNames = ['manifestCreateFileLocation', 'workspaceDirectory', 'workspaceDestinationDirectory', 'sessionTargetReady', 'sessionTargetState', 'treeMessage'] as const;
  return {
    async invoke(method, args) {
      if (method === 'updateLogPreferenceSnapshot') {
        storage.set(logPreferenceKey, readLogPreferences(args[0]));
        await api.readLogPreferences(); return {};
      }
      // Finite own methods only. Never prototype access, arbitrary paths, code,
      // dynamic imports, disposal, listeners, or the tree object itself.
      if (!Object.hasOwn(calls, method) || method.startsWith('on') || method === 'dispose' || method === 'saveLogPreferences' || typeof calls[method] !== 'function') throw new BoundaryError('INVALID_INPUT');
      const pending: WorkspaceEffect[] = [];
      const value = await effects.run(pending, () => (calls[method] as (...values: unknown[]) => unknown)(...args));
      if (value !== undefined && ['sessionsOverview', 'stopGateStatus', 'readRequestDiagnostics', 'compareFileConflict'].includes(method)) emit(`result:${method}`, value);
      if (method === 'listSessions' && value !== undefined) emit('result:sessionsOverview', value);
      if (value !== undefined && ['localTunnelStart', 'clusterProviders', 'minikubeConfigView', 'telepresenceStatus'].includes(method)) emit(`result:${method}`, value);
      return { ...(value === undefined ? {} : { value }), ...(pending.length ? { effects: pending } : {}) };
    },
    selectors() {
      const values: Record<string, unknown> = {};
      for (const name of selectorNames) {
        const value = api[name](); if (value !== undefined) values[name] = value;
      }
      values.fileSaveDefault = [api.fileSaveDefault('live'), api.fileSaveDefault('file')];
      const apply = latest.get('onManifestApply')?.[0] as { history?: { id: string }[] } | undefined;
      values.canQueryManifestApply = (apply?.history ?? []).map(value => value.id).filter(id => api.canQueryManifestApply(id));
      return values;
    },
    locale(value) { if (locale === value) return; locale = value; ready?.({ directory: options.directory, locale }); },
    close: () => api.dispose(),
  };
}
