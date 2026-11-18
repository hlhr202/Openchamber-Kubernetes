// One-shot low-level HTTPS request core shared by the direct WRITE transports.
// Never imported by reads, tests, health or bootstrap. One request, one body, one socket per call:
// no fetch redirect/retry wrapper, kubectl retry loop or generic URL API.
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
export type OnceConnection = { readonly server: URL; readonly token: string; readonly ca?: Buffer; readonly credentialsRejected?: () => void };
export const knownRejection = (status: number): ErrorCode => (status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'CONTENT_INVALID');
// Known API rejections map to fixed codes without reading the error body; every other status, truncation,
// socket error or projection mismatch stays the caller-provided fallback (unknown) and is never replayed.
export function onceRequest<R>(connection: OnceConnection, url: URL, method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT', contentType: string, successStatus: number, body: Buffer | undefined, signal: AbortSignal,
  fallback: R, fail: (code: ErrorCode) => R, project: (value: unknown, raw: string) => R | undefined): Promise<R> {
  return new Promise<R>(resolve => {
    let result: R = fallback, raw = '', total = 0; const chunks: Buffer[] = [];
    const request = httpsRequest(url, { method, agent: false, rejectUnauthorized: true, maxHeaderSize: 16_384,
      ...(connection.ca ? { ca: connection.ca } : {}), headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': contentType, Accept: 'application/json', 'Accept-Encoding': 'identity', ...(body ? { 'Content-Length': body.length } : {}), Connection: 'close' } }, response => {
      const status = response.statusCode ?? 0;
      if (status === 401) connection.credentialsRejected?.(); // Next explicit request renews; never replay this write.
      response.once('error', () => request.destroy()); response.once('aborted', () => request.destroy());
      if ([400, 401, 403, 404, 405, 409, 415, 422].includes(status)) {
        result = fail(knownRejection(status)); response.destroy(); return;
      }
      if (status !== successStatus || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); return; }
      response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 2_000_000) request.destroy(); else chunks.push(chunk); });
      response.once('end', () => {
        try {
          if (!response.complete || total > 2_000_000) return;
          raw = Buffer.concat(chunks).toString('utf8');
          const projected = project(undefined, raw); if (projected !== undefined) result = projected;
        } catch { /* Sensitive malformed/late/truncated success remains unknown, never replay. */ }
      });
    });
    const timer = setTimeout(() => request.destroy(), 7000), abort = () => request.destroy();
    signal.addEventListener('abort', abort, { once: true }); request.once('error', () => { /* No sensitive socket/credential error output. */ });
    request.once('upgrade', (response: IncomingMessage, socket: Socket) => { response.destroy(); socket.destroy(); request.destroy(); });
    request.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); for (const chunk of chunks) chunk.fill(0); resolve(result); });
    if (signal.aborted) request.destroy(); else request.end(body); // One request body, no resend branch or 401/429/Retry-After retry.
  });
}
export function requireBoundedName(value: string | undefined): string { if (!value || value.length < 1 || value.length > 1024) throw new BoundaryError('CONTENT_INVALID'); return value; }
