export type ReadTicket = { readonly epoch: number; readonly requestId: number };

// UI correlation, NOT a host-authenticated owner claim. Service ownership is separate.
export class ReadGeneration {
  #epoch = 0;
  #requestId = 0;
  #directory: string | null = null;
  #serviceGeneration: string | null = null;
  #disposed = false;

  update(directory: string | null, serviceGeneration: string | null): void {
    if (directory !== this.#directory || serviceGeneration !== this.#serviceGeneration) {
      this.#directory = directory;
      this.#serviceGeneration = serviceGeneration;
      this.#epoch++;
    }
  }

  capture(): ReadTicket {
    return Object.freeze({ epoch: this.#epoch, requestId: ++this.#requestId });
  }

  current(ticket: ReadTicket): boolean {
    return !this.#disposed && ticket.epoch === this.#epoch;
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch++;
  }
}
