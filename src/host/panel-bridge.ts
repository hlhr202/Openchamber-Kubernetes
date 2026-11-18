import { connectHost } from '@openchamber/sdk';
import type { HostClient } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import type { createProjectRuntime } from './bridge.ts';
import { ProjectWorkspaceConnection } from './project-workspace-connection.ts';
import { workspaceCallbackChannels } from '../shared/project-workspace-protocol.ts';
import type { WorkspaceEffect } from '../shared/project-workspace-protocol.ts';
import { inspectionSyntaxTheme } from '../shared/presentation-theme.ts';
import { logPreferenceKey, readLogPreferences } from '../shared/log-preferences.ts';
import { createLogPreferenceWriter } from './log-preference-writer.ts';
import { restoreScene, sceneRestoring, isSceneRestoring, sceneChanged } from '../panel/workspace-scene.ts';
import { mountSceneCheckpoints } from '../panel/scene-checkpoints.ts';
import { samePresentation } from '../shared/presentation-state.ts';
import { createPanelLanguage, panelText } from '../panel/i18n.ts';
import type { PanelLocale, PanelMessage } from '../panel/i18n.ts';

type Runtime = ReturnType<typeof createProjectRuntime>;
type Callbacks = Parameters<typeof createProjectRuntime> extends [unknown, ...infer Rest] ? Rest : never;
type ViewerApi = Runtime & {
  onWorkspaceResult(callback: (method: string, value: unknown) => void): () => void;
  onWorkspaceSelectors(callback: () => void): () => void;
};
export function mountHostBridge(root: HTMLElement, onLocale: (locale: PanelLocale) => void, ...callbacks: Callbacks): ViewerApi {
  const host: HostClient = connectHost(), document = root.ownerDocument;
  const listeners = new Map<string, ((...args: unknown[]) => void)>(), versions = new Map<string, number>();
  for (const [index, name] of workspaceCallbackChannels.entries()) {
    const callback = callbacks[index]; if (typeof callback === 'function') listeners.set(name, callback as (...args: unknown[]) => void);
  }
  let disposed = false, attached = false, attaching = false, timer: ReturnType<typeof setTimeout> | undefined;
  let selectors: Record<string, unknown> = {}, latestUi: Record<string, unknown> | undefined, saving = false, clipboardPending = false;
  let saveTask: Promise<void> | undefined;
  let appearance: unknown;
  let locale: PanelLocale | undefined;
  let directory: string | null | undefined;
  const pendingEdits = new Map<string, number>(), deferredEdits = new Map<string, { version: number; args: unknown[] }>();
  const present = (channel: string, state: { version: number; args: unknown[] }) => {
    if (disposed || (versions.get(channel) ?? 0) >= state.version) return;
    if (pendingEdits.get(channel)) { deferredEdits.set(channel, state); return; }
    versions.set(channel, state.version);
    if (channel.startsWith('result:')) listeners.get('onWorkspaceResult')?.(channel.slice(7), ...state.args);
    else listeners.get(channel)?.(...state.args);
  };
  const banner = document.createElement('p'); banner.setAttribute('role', 'status'); banner.hidden = true;
  root.before(banner); root.inert = true; sceneRestoring(document, true);
  let bannerMessage: PanelMessage = 'workspace.noProject';
  const showBanner = (message: PanelMessage) => {
    bannerMessage = message;
    banner.hidden = false;
    banner.textContent = panelText(locale ?? 'en', bannerMessage);
  };
  const updateLanguage = createPanelLanguage(document, language => {
    locale = language;
    if (!banner.hidden) showBanner(bannerMessage);
    onLocale(language);
  });
  const failure = () => {
    if (disposed) return;
    showBanner('workspace.disconnected');
    root.inert = true;
    if (timer) clearTimeout(timer);
  };
  const effects = async (values: WorkspaceEffect[]) => {
    for (const value of values) {
      if (disposed) throw new Error('VIEW_EXPIRED');
      if (value.kind === 'clipboard') {
        if (clipboardPending) throw new Error('COPY_LIMIT');
        clipboardPending = true;
        try { await host.writeClipboard(value.text); } finally { clipboardPending = false; }
      }
      else if (value.kind === 'open-url') await host.openUrl(value.url);
      else if (value.kind === 'storage' && value.key === logPreferenceKey) await host.storage.set(value.key, { ...readLogPreferences(value.value) }, { scope: 'instance' });
      else throw new Error('INVALID_EFFECT');
    }
  };
  const connection = new ProjectWorkspaceConnection(request => host.serviceRequest(request), (frame, initial) => {
    if (disposed) return;
    const selectorsChanged = JSON.stringify(selectors) !== JSON.stringify(frame.selectors);
    selectors = frame.selectors;
    if (initial) sceneRestoring(document, true);
    for (const [channel, state] of Object.entries(frame.states).sort((a, b) => a[1].version - b[1].version)) {
      present(channel, state);
    }
    if (selectorsChanged && ![...pendingEdits.values()].some(Boolean)) listeners.get('onWorkspaceSelectors')?.();
    if (initial) {
      root.inert = false; // Focus cannot be restored while the subtree is inert.
      if (frame.ui && Object.keys(frame.ui.value).length) restoreScene(document, root, frame.ui.value);
      // Keep the guard through queued defaults/autorun microtasks. Reattaching
      // a view is never permission to start a fresh stream or replay a command.
      queueMicrotask(() => {
        if (disposed) return; sceneRestoring(document, false); root.inert = false;
      });
    }
    // A real state delta may update local draft defaults/scroll models. Capture
    // once after the batch, never by observing the DOM produced by painting it.
    if (!initial && (selectorsChanged || Object.keys(frame.states).length)) checkpoints.checkpoint();
  }, effects);
  const preferenceWriter = createLogPreferenceWriter((key, value) => host.storage.set(key, { ...value }, { scope: 'instance' }));
  const pump = async () => {
    if (disposed || !attached) return;
    try { await connection.read(); }
    catch { failure(); return; }
    if (!disposed) timer = setTimeout(() => { void pump(); }, 500);
  };
  const stopReady = host.onReady(context => {
    if (disposed) return;
    const next = { theme: context.theme, locale: context.locale };
    if (!samePresentation(appearance, next)) {
      appearance = next; applyHostReady(context, root);
      for (const [name, value] of Object.entries(inspectionSyntaxTheme(context.theme.tokens))) root.style.setProperty(name, value);
      updateLanguage(context.locale);
      sceneChanged(root, 'appearance');
    }
    if (disposed || attaching || attached) return;
    if (!context.directory) { showBanner('workspace.noProject'); return; }
    directory = context.directory; attaching = true;
    void (async () => {
      let preferences: unknown;
      try { preferences = await host.storage.get(logPreferenceKey, { scope: 'instance' }); } catch { /* Reader reports defaults; storage is independently granted. */ }
      await connection.attach(context.directory!, context.locale, preferences);
      if (disposed) return; attached = true; attaching = false;
      banner.hidden = true; void pump();
    })().catch(failure);
  });
  const stopDirectory = host.onDirectory(value => {
    // The entry manager remounts a viewer for a real directory change. Never
    // let a late callback from the old project paint or dispatch into the new one.
    if (directory !== undefined && value !== directory) { root.inert = true; attached = false; if (timer) clearTimeout(timer); }
  });
  const save = (): Promise<void> | undefined => {
    if (saving) return saveTask;
    if (disposed || !attached || isSceneRestoring(document)) return;
    saving = true;
    saveTask = (async () => {
      try {
        do { const value = latestUi; latestUi = undefined; if (value) await connection.saveUi(value); } while (latestUi);
      } catch { failure(); }
      finally { saving = false; }
    })();
    return saveTask;
  };
  const checkpoints = mountSceneCheckpoints(root, () => !disposed && attached, value => { latestUi = value; void save(); });
  const invoke = (method: string, args: unknown[]) => {
    if (disposed || !attached || isSceneRestoring(document)) return Promise.resolve(undefined);
    // A failure never retries a user operation. Internal callers often use
    // void; keep failure visible without an unhandled promise rejection loop.
    const editChannel = method === 'editDocument' ? 'document' : method === 'editWorkspaceFile' ? 'onWorkspace' : undefined;
    if (editChannel) pendingEdits.set(editChannel, (pendingEdits.get(editChannel) ?? 0) + 1);
    return connection.command(method, args).catch(() => { failure(); return undefined; }).finally(() => {
      if (!editChannel) return;
      const remaining = (pendingEdits.get(editChannel) ?? 1) - 1;
      pendingEdits.set(editChannel, remaining);
      if (!remaining) {
        const state = deferredEdits.get(editChannel); deferredEdits.delete(editChannel);
        if (state) present(editChannel, state);
        if (!disposed && ![...pendingEdits.values()].some(Boolean)) listeners.get('onWorkspaceSelectors')?.();
      }
    });
  };
  return new Proxy({} as ViewerApi, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property.startsWith('on')) return (callback: (...args: unknown[]) => void) => {
        listeners.set(property, callback);
        return () => { if (listeners.get(property) === callback) listeners.delete(property); };
      };
      if (property === 'dispose') return () => {
        if (disposed) return;
        // Best effort final scene before detaching; acknowledged memory survives,
        // an iframe killed before its RPC arrives still cannot be guaranteed.
        checkpoints.flush();
        const finalSave = save();
        disposed = true;
        if (timer) clearTimeout(timer);
        checkpoints.dispose();
        stopReady(); stopDirectory();
        void Promise.resolve(finalSave).finally(() => { connection.dispose(); host.dispose(); });
        banner.remove();
        // No project runtime reset, stream release, session close or write replay.
      };
      if (property === 'tree') return undefined; // Runtime-private controller; views subscribe to onTree.
      if (property === 'fileSaveDefault') return (kind: 'live' | 'file') => (selectors.fileSaveDefault as unknown[] | undefined)?.[kind === 'live' ? 0 : 1];
      if (property === 'canQueryManifestApply') return (id: string) => (selectors.canQueryManifestApply as string[] | undefined)?.includes(id) ?? false;
      if (['manifestCreateFileLocation', 'workspaceDirectory', 'workspaceDestinationDirectory', 'sessionTargetReady', 'sessionTargetState', 'treeMessage'].includes(property)) return () => selectors[property] ?? (property === 'manifestCreateFileLocation' ? {} : undefined);
      if (property === 'copyLogPage') return (text: string) => {
        if (!text || text.length > 100_000 || clipboardPending) return Promise.reject(new Error('COPY_LIMIT'));
        clipboardPending = true; return host.writeClipboard(text).finally(() => { clipboardPending = false; });
      };
      if (property === 'saveLogPreferences') return (value: unknown) => preferenceWriter.save(value);
      if (property === 'readLogPreferences') return async () => {
        if (disposed || !attached || isSceneRestoring(document)) return;
        try {
          const value = await host.storage.get(logPreferenceKey, { scope: 'instance' });
          await invoke('updateLogPreferenceSnapshot', [value]);
        } catch { failure(); }
      };
      return (...args: unknown[]) => invoke(property, args);
    },
  });
}
