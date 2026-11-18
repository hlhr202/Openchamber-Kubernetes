// Pure exact-source/canonical-payload comparison; no transport, controller, filesystem or receipt authorization.
import { BoundaryError } from '../shared/errors.ts';
import { saveContentSnapshot } from '../shared/save-content.ts';
import { encodeCreateSource } from './manifest-create-source.ts';
export function verifiedManifestFilePayload(text: string, format: 'yaml' | 'json', expected: { sourceDigest: string; payloadDigest: string; payloadBytes: number }): string {
  const source = saveContentSnapshot(text);
  try { if (source.digest !== expected.sourceDigest) throw new BoundaryError('CONFLICT'); } finally { source.bytes.fill(0); }
  const canonical = encodeCreateSource(text, format), payload = saveContentSnapshot(canonical);
  try { if (payload.digest !== expected.payloadDigest || payload.bytes.length !== expected.payloadBytes) throw new BoundaryError('CONFLICT'); }
  finally { payload.bytes.fill(0); }
  return canonical;
}
