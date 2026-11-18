import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';

// Per-service in-memory key. Tokens are read capabilities, never authenticated host owners.
export function createSealedCursor(prefix: string, audience: string) {
  const key = randomBytes(32);
  let disposed = false;
  return {
    seal(value: unknown): string {
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 12_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(audience));
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `${prefix}.${Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url')}`;
    },
    open(token: string): unknown {
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      try {
        if (token.length > 17_000 || !token.startsWith(`${prefix}.`)) throw new Error('format');
        const encoded = token.slice(prefix.length + 1);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('format');
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded || bytes.length < 29 || bytes.length > 12_028) throw new Error('length');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(audience)); decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
      } catch { throw new BoundaryError('STALE_TARGET'); }
    },
    dispose() { disposed = true; key.fill(0); },
  };
}
