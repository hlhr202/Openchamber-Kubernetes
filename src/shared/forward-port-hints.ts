import { z } from 'zod';

const portNumber = z.number().int().min(1).max(65535);
const maximumHints = 64;
export const forwardPortHintsSchema = z.array(portNumber).max(maximumHints).refine(ports => new Set(ports).size === ports.length);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Called on an already validated, byte-bounded list item. Only port numbers leave
// the projector; declarations are suggestions, not proof of a listening process.
export function projectForwardPortHints(value: unknown, resource: 'pods' | 'services'): number[] {
  const spec = record(record(value)?.spec), ports = new Set<number>();
  const collect = (entries: unknown, key: 'port' | 'containerPort') => {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const entry = record(raw);
      if (!entry || (entry.protocol !== undefined && entry.protocol !== 'TCP')) continue;
      const parsed = portNumber.safeParse(entry[key]);
      if (parsed.success) ports.add(parsed.data);
      if (ports.size >= maximumHints) break;
    }
  };
  if (resource === 'services') collect(spec?.ports, 'port');
  else if (Array.isArray(spec?.containers)) for (const raw of spec.containers) {
    collect(record(raw)?.ports, 'containerPort');
    if (ports.size >= maximumHints) break;
  }
  return [...ports];
}

export function suggestedForwardMapping(remote: number, used: ReadonlySet<number> = new Set()): string {
  // Avoid binding a privileged number by default; the value remains editable.
  let local = remote < 1024 ? 8000 + remote : remote;
  while (used.has(local)) local = local === 65535 ? 1024 : local + 1;
  return `${local}:${remote}`;
}
