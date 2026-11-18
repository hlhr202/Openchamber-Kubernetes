import { mountButton } from '@openchamber/sdk/ui';
import type { CopyNameSelection } from '../host/copy-name.ts';
import type { mountHostBridge } from '../host/bridge.ts';

// Only an explicit click can reach the host clipboard writer. No body/value is accepted here.
export function mountCopyNameButton(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, selection: CopyNameSelection, zh: boolean, disabled: boolean) {
  const status = document.createElement('span'); status.setAttribute('role', 'status'); container.append(status);
  let disposed = false, pending = false;
  const button = mountButton(container, { label: zh ? '复制名称' : 'Copy Name', variant: 'ghost', disabled,
    onClick: () => {
      const host = bridge(); if (disabled || disposed || pending || !host) return;
      pending = true; status.textContent = ''; button.update({ disabled: true });
      void host.copyName(selection).then(() => { if (!disposed) status.textContent = zh ? '名称已复制' : 'Name copied'; })
        .catch(() => { if (!disposed) status.textContent = zh ? '复制结果未确认；未自动重试' : 'Copy not confirmed; not retried'; })
        .finally(() => { pending = false; if (!disposed) button.update({ disabled }); });
    } });
  return () => { disposed = true; status.textContent = ''; button.dispose(); status.remove(); };
}
