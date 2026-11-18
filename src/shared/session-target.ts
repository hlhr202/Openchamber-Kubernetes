import { z } from 'zod';
import { documentReferenceId, documentReferenceSchema } from './document-protocol.ts';
import type { DocumentReference } from './document-protocol.ts';
import { configSelectionSchema } from './configuration.ts';
import type { ConfigSelection } from './configuration.ts';
import { targetSchema, namespaceName, dnsName, boundedName, containsControlCharacters } from './identity.ts';
import type { TargetIdentity } from './identity.ts';
import type { ErrorCode } from './errors.ts';

export const sessionReferenceSchema = documentReferenceSchema.refine(reference =>
  reference.namespace !== undefined && ((reference.type.group === '' && ['pods', 'services'].includes(reference.type.resource))
    || (reference.type.group === 'apps' && reference.type.resource === 'deployments')));
export const sessionSelectionSchema = z.object({ target: targetSchema, selection: configSelectionSchema, reference: sessionReferenceSchema }).strict();
export const sessionPublicTargetSchema = z.object({
  namespace: namespaceName, podName: dnsName, podUid: boundedName, container: namespaceName.optional(),
  original: z.object({ resource: z.enum(['services', 'deployments']), name: dnsName, namespace: namespaceName, uid: boundedName, resourceVersion: boundedName }).strict().optional(),
}).strict();
export type SessionTargetState = {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  target?: TargetIdentity; selection?: ConfigSelection; reference?: DocumentReference;
  containers: readonly string[]; container?: string; error?: ErrorCode;
  forwardPorts?: readonly number[];
};
export function forwardSelectionKey(state: SessionTargetState): string | undefined {
  const target = state.target, reference = state.reference;
  if (state.phase !== 'ready' || !target || !reference) return undefined;
  return JSON.stringify([target.serviceGeneration, target.projectId, target.configIdentity, target.context, target.namespace, documentReferenceId(reference)]);
}
export type SessionOpenTarget = {
  namespace: string; pod: string; podUid: string; podResourceVersion: string; container?: string;
} | { original: { resource: 'services' | 'deployments'; namespace: string; name: string; uid: string; resourceVersion: string } };
export function sessionOpenTarget(state: SessionTargetState, containerRequired: boolean): SessionOpenTarget | undefined {
  const reference = state.reference;
  if (state.phase !== 'ready' || !reference?.namespace || !state.target || !state.selection) return undefined;
  if (reference.type.resource !== 'pods') {
    if (containerRequired || !['services', 'deployments'].includes(reference.type.resource)) return undefined;
    return { original: { resource: reference.type.resource as 'services' | 'deployments', namespace: reference.namespace,
      name: reference.name, uid: reference.uid, resourceVersion: reference.resourceVersion } };
  }
  if (containerRequired && (!state.container || !state.containers.includes(state.container))) return undefined;
  return { namespace: reference.namespace, pod: reference.name, podUid: reference.uid, podResourceVersion: reference.resourceVersion,
    ...(containerRequired ? { container: state.container! } : {}) };
}
export function parseSessionPorts(value: string): { local: number; remote: number }[] | undefined {
  const pieces = value.split(','); if (!pieces.length || pieces.length > 8) return undefined;
  const ports: { local: number; remote: number }[] = [];
  for (const piece of pieces) {
    const match = /^\s*(\d{1,5}):(\d{1,5})\s*$/.exec(piece); if (!match) return undefined;
    const local = Number(match[1]), remote = Number(match[2]);
    if (local < 1 || local > 65535 || remote < 1 || remote > 65535 || ports.some(port => port.local === local || port.remote === remote)) return undefined;
    ports.push({ local, remote });
  }
  return ports;
}
// Container argv parsing only. Never evaluates a shell, substitutions or pipes.
export function parseSessionCommand(value: string): string[] | undefined {
  if (!value.trim() || value.length > 4096 || value.includes('\0')) return undefined;
  const parts: string[] = []; let part = '', quote = '', escaped = false, started = false;
  for (const character of value) {
    if (escaped) { part += character; escaped = false; started = true; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (character === quote) quote = ''; else part += character; started = true; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) { parts.push(part); part = ''; started = false; } }
    else { part += character; started = true; }
  }
  if (quote || escaped) return undefined;
  if (started) parts.push(part);
  if (!parts[0] || parts.length > 16 || parts.some(part => part.length > 256)) return undefined;
  return parts;
}
export function sessionActionAvailability(state: { phase: string; id?: string; error?: string }, selected: SessionTargetState,
  input: { shell: string; command: string; ports: string; choosing?: boolean }) {
  const blocked = state.phase === 'opening' || !!state.id || state.error === 'OPERATION_UNKNOWN' || input.choosing === true;
  return {
    terminal: !blocked && !!input.shell && input.shell === input.shell.trim() && input.shell.length <= 256
      && !containsControlCharacters(input.shell) && !!sessionOpenTarget(selected, true),
    exec: !blocked && !!parseSessionCommand(input.command) && !!sessionOpenTarget(selected, true),
    forward: !blocked && !!parseSessionPorts(input.ports) && !!sessionOpenTarget(selected, false),
  };
}
