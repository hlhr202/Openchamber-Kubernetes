// Host ready is a repeatable snapshot, NOT a mount/reload signal. Session, busy,
// title and theme are deliberately absent from the data scope.
export class HostSnapshotLifecycle {
  #directory: string | null | undefined;
  #ready = false;
  ready(directory: string | null): { initialize: boolean; projectChanged: boolean } {
    const initialize = !this.#ready;
    this.#ready = true;
    return { initialize, projectChanged: this.directory(directory) };
  }
  directory(directory: string | null): boolean {
    if (this.#directory === directory) return false;
    this.#directory = directory;
    return true;
  }
}
