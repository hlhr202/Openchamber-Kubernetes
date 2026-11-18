// Pure admission/consumer state, NOT an authentication executor. No callbacks, I/O or timers.
import { BoundaryError } from '../../shared/errors.ts';
type Flight = { key: string; consumers: Set<number>; retired: boolean };
export function createCredentialFlightState() {
  const flights = new Map<number, Flight>(), active = new Map<string, number>();
  let sequence = 0, consumerSequence = 0, consumerCount = 0, closed = false;
  return {
    join(key: string) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      if (consumerCount >= 64) throw new BoundaryError('QUERY_LIMIT');
      let ticket = active.get(key);
      const created = ticket === undefined;
      if (ticket === undefined) {
        if (flights.size >= 2) throw new BoundaryError('QUERY_LIMIT');
        ticket = ++sequence;
        flights.set(ticket, { key, consumers: new Set(), retired: false });
        active.set(key, ticket);
      }
      const consumer = ++consumerSequence;
      flights.get(ticket)?.consumers.add(consumer);
      consumerCount++;
      return { ticket, consumer, created };
    },
    leave(ticket: number, consumer: number): boolean {
      const flight = flights.get(ticket);
      if (!flight || !flight.consumers.delete(consumer)) return false;
      consumerCount--;
      if (flight.consumers.size || flight.retired) return false;
      flight.retired = true;
      if (active.get(flight.key) === ticket) active.delete(flight.key);
      return true; // Last consumer: caller should abort, but the slot stays until settle.
    },
    usable(ticket: number) {
      const flight = flights.get(ticket);
      return !closed && !!flight && !flight.retired && flight.consumers.size > 0;
    },
    settle(ticket: number) {
      const flight = flights.get(ticket);
      if (!flight) return;
      consumerCount -= flight.consumers.size;
      if (active.get(flight.key) === ticket) active.delete(flight.key);
      flights.delete(ticket);
    },
    close() {
      closed = true;
      active.clear();
      for (const flight of flights.values()) flight.retired = true;
      return [...flights.keys()];
    },
    get counts() { return { running: flights.size, consumers: consumerCount }; },
  };
}
