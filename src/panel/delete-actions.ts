import { mountButton } from '@openchamber/sdk/ui';
import type { DocumentReference } from '../shared/document-protocol.ts';
import type { mountHostBridge } from '../host/bridge.ts';

export function mountDeleteActions(container: HTMLElement, reference: DocumentReference, bridge: () => ReturnType<typeof mountHostBridge> | undefined, zh: boolean, disabled: boolean): () => void {
  if (reference.type.resource === 'namespaces') {
    const button = mountButton(container, { label: zh ? '删除Namespace…' : 'Delete Namespace…', variant: 'outline', disabled,
      onClick: () => bridge()?.openNamespaceDelete(reference) }); return () => button.dispose();
  }
  const buttons = [mountButton(container, { label: zh ? '删除…' : 'Delete…', variant: 'outline', disabled, onClick: () => { void bridge()?.prepareDelete({ reference, mode: 'standard' }); } })];
  if (reference.type.group === '' && reference.type.resource === 'pods') buttons.push(mountButton(container, { label: zh ? 'Delete Now…' : 'Delete Now…', variant: 'outline', disabled,
    onClick: () => { void bridge()?.prepareDelete({ reference, mode: 'now' }); } }));
  return () => { for (const button of buttons) button.dispose(); };
}
