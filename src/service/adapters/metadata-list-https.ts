// A narrow GET-only transport. Never imported or run by automated functional tests.
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { metadataListAccept, validateMetadataListRead } from '../queries/resource-list-representation.ts';
import type { ResourceReadRequest } from '../queries/resource-reader.ts';
import type { ReadResponse } from '../queries/bounded-response.ts';

const material = z.string().min(1).max(2_000_000);
const snapshot = z.object({
  clusters: z.tuple([z.object({ cluster: z.object({
    server: z.string(), 'certificate-authority-data': material.optional(), 'disable-compression': z.boolean().optional(),
  }).strict() })]),
  users: z.tuple([z.object({ user: z.object({
    token: z.string().min(1).max(16_384).regex(/^[\x21-\x7e]+$/).optional(),
    'client-certificate-data': material.optional(), 'client-key-data': material.optional(),
  }).strict() })]),
});

// The snapshot is already bound by privateKubectlConfiguration. No new
// credential resolver. Unsupported settings keep the existing CLI path,
// decided before I/O, not by retrying after an HTTP or TLS failure.
export async function tryMetadataList(request: ResourceReadRequest, input: Uint8Array, signal: AbortSignal): Promise<ReadResponse | undefined> {
  validateMetadataListRead(request);
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  if (process.env.NODE_DEBUG || process.env.NODE_OPTIONS || process.execArgv.some(arg => arg.startsWith('--tls-keylog'))
    || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy) return undefined;
  const parsed = snapshot.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)));
  if (!parsed.success) return undefined;
  const { cluster } = parsed.data.clusters[0], { user } = parsed.data.users[0];
  const server = new URL(cluster.server);
  if (server.protocol !== 'https:' || server.pathname !== '/' || server.username || server.password || server.search || server.hash) return undefined;
  if ((!user.token && !user['client-certificate-data']) || !!user['client-certificate-data'] !== !!user['client-key-data']) return undefined;
  const buffers: Buffer[] = [];
  const decode = (encoded?: string) => {
    if (encoded === undefined) return undefined;
    const bytes = Buffer.from(encoded, 'base64'); buffers.push(bytes);
    return bytes.length && bytes.length <= 1_000_000 && bytes.toString('base64') === encoded ? bytes : null;
  };
  try {
    const ca = decode(cluster['certificate-authority-data']), cert = decode(user['client-certificate-data']), key = decode(user['client-key-data']);
    // Not a format supported by this narrow adapter; preserve the original
    // kubeconfig behavior in the CLI (for example, line-wrapped base64).
    if (ca === null || cert === null || key === null) return undefined;
    const url = new URL(request.path, server);
    url.search = new URLSearchParams(request.query).toString();
    return await new Promise<ReadResponse>((resolve, reject) => {
      let status = 0, total = 0, retryAfterMs: number | undefined, failure: BoundaryError | undefined;
      let complete = false;
      const chunks: Buffer[] = [];
      const client = httpsRequest(url, { method: 'GET', agent: false, rejectUnauthorized: true, maxHeaderSize: 16_384,
        ca, cert, key, headers: { Accept: metadataListAccept, 'Accept-Encoding': 'identity', Connection: 'close',
          ...(user.token ? { Authorization: `Bearer ${user.token}` } : {}) },
      }, response => {
        status = response.statusCode ?? 0;
        response.once('error', () => client.destroy());
        if (status !== 200) {
          const retryAfter = response.headers['retry-after'];
          if (status === 429 && typeof retryAfter === 'string' && /^[1-9]\d{0,8}$/.test(retryAfter)) retryAfterMs = Math.min(60_000, Number(retryAfter) * 1000);
          // Return fixed status only. Never drain sensitive error text or follow redirects.
          complete = true; response.destroy(); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); return; }
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > request.maximumBytes || chunks.length >= 4096) {
            failure = new BoundaryError('BUDGET_EXCEEDED'); client.destroy(); return;
          }
          if (!failure) chunks.push(chunk);
        });
        response.once('end', () => { complete = response.complete; });
      });
      const abort = () => { failure = new BoundaryError('QUERY_CANCELLED'); client.destroy(); };
      const timer = setTimeout(() => { failure = new BoundaryError('QUERY_TIMEOUT'); client.destroy(); }, 7000);
      signal.addEventListener('abort', abort, { once: true });
      client.once('error', () => { /* TLS and transport details never reach the panel. */ });
      client.once('upgrade', (response, socket) => { response.destroy(); socket.destroy(); client.destroy(); });
      client.once('close', () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        const body = !failure && complete && status === 200 ? Buffer.concat(chunks, total) : undefined;
        for (const chunk of chunks) chunk.fill(0);
        if (failure || !complete) { reject(failure ?? new BoundaryError('STATE_UNAVAILABLE')); return; }
        resolve({ status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          body: { async *[Symbol.asyncIterator]() { if (body) yield body; } },
          async close() { body?.fill(0); } });
      });
      if (signal.aborted) abort(); else client.end();
    });
  } finally { for (const bytes of buffers) bytes.fill(0); }
}
