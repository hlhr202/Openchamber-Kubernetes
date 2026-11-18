import { mountPanel } from './main.ts';
import { connectHost } from '@openchamber/sdk';

// The browser build's explicit executable entry, never imported by read-only tests.
const host = connectHost();
let directory: string | null | undefined, dispose: (() => void) | undefined;
function activate(value: string | null): void {
  if (value === directory) return;
  directory = value; dispose?.(); dispose = mountPanel(document);
}
host.onReady(context => activate(context.directory));
host.onDirectory(activate);
