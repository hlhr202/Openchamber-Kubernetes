import { z } from 'zod';
import { BoundaryError } from './errors.ts';

export const portMappingLimits = Object.freeze({ characters: 512, mappings: 16, suggestions: 256 });
const suggestion = z.object({ name: z.string().regex(/^(?=.{1,15}$)(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/), port: z.number().int().min(1).max(65535) }).strict();
export type PortMapping = { readonly localPort: number | null; readonly targetPort: number };

// Pure input grammar only: no allocation/reservation, CLI arguments, target resolution, intent or session control.
// null means a future explicit session must allocate a Server port; it is never a ready/listening claim.
export function parsePortMappings(input: unknown, suggestions: unknown = []): readonly PortMapping[] {
  if (typeof input !== 'string') throw new BoundaryError('INVALID_INPUT');
  if (input.length > portMappingLimits.characters || Array.isArray(suggestions) && suggestions.length > portMappingLimits.suggestions) throw new BoundaryError('BUDGET_EXCEEDED');
  const parsed = z.array(suggestion).max(portMappingLimits.suggestions).safeParse(suggestions);
  if (!parsed.success) throw new BoundaryError('CONTENT_INVALID');
  const named = new Map<string, number>();
  for (const item of parsed.data) {
    const previous = named.get(item.name);
    if (previous !== undefined && previous !== item.port) throw new BoundaryError('CONTENT_INVALID');
    named.set(item.name, item.port);
  }
  // Only ASCII spaces separate mappings. Control/Unicode whitespace, addresses, flags and shell syntax fail closed.
  if (!/^[a-z0-9: -]+$/.test(input)) throw new BoundaryError('INVALID_INPUT');
  const pairs = input.trim().split(/ +/);
  if (pairs.length > portMappingLimits.mappings) throw new BoundaryError('BUDGET_EXCEEDED');
  const port = (token: string, local: boolean): number | null => {
    if (local && (token === '' || token === '0')) return null;
    const known = named.get(token); if (known !== undefined) return known;
    if (!/^\d{1,5}$/.test(token)) throw new BoundaryError('INVALID_INPUT');
    const value = Number(token); if (value < 1 || value > 65535) throw new BoundaryError('INVALID_INPUT');
    return value;
  };
  const occupied = new Set<number>();
  return Object.freeze(pairs.map(pair => {
    const parts = pair.split(':'); if (parts.length > 2) throw new BoundaryError('INVALID_INPUT');
    const localPort = parts.length === 2 ? port(parts[0] ?? '', true) : null;
    const targetPort = port(parts.at(-1) ?? '', false);
    if (targetPort === null) throw new BoundaryError('INVALID_INPUT');
    if (localPort !== null) { if (occupied.has(localPort)) throw new BoundaryError('INVALID_INPUT'); occupied.add(localPort); }
    return Object.freeze({ localPort, targetPort });
  }));
}
