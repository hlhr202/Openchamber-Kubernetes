// READ ONLY. Pure in-memory decoder for helm.sh/release.v1 Secrets (D-01 approved read path):
// outer Kubernetes Base64 -> inner Helm Base64 -> Gzip -> Release JSON. Never writes, never
// materialises a kubeconfig, never keeps secrets on disk; output is metadata-only projections.
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, namespaceName } from '../../shared/identity.ts';

export const helmReleaseMaxBytes = 1_048_576;
const releaseName = z.string().min(1).max(253).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
const releaseStatus = z.enum(['unknown', 'deployed', 'uninstalled', 'superseded', 'failed', 'uninstalling', 'pending-install', 'pending-upgrade', 'pending-rollback']);
export const helmReleaseSecretLabelsSchema = z.object({ owner: z.literal('helm'), name: releaseName, version: z.string().regex(/^\d+$/).max(10), status: releaseStatus }).strict();
export type HelmReleaseSecretLabels = z.infer<typeof helmReleaseSecretLabelsSchema>;
const releasePayloadSchema = z.object({
  name: releaseName, namespace: namespaceName, version: z.number().int().min(1).max(1_000_000),
  info: z.object({ first_deployed: z.string().max(64).optional(), last_deployed: z.string().max(64).optional(), status: releaseStatus, description: z.string().max(1024).optional() }).strict(),
  chart: z.object({ metadata: z.object({ name: releaseName, version: z.string().min(1).max(64).regex(/^[0-9][^+/]*$/), appVersion: z.string().max(256).optional() }).strict() }).strict(),
  manifest: z.string().max(helmReleaseMaxBytes).optional(), config: z.unknown().optional(), hooks: z.array(z.unknown()).max(128).optional(),
}).strict();
export type HelmReleaseRevision = {
  readonly name: string; readonly namespace: string; readonly revision: number; readonly status: z.infer<typeof releaseStatus>;
  readonly chartName: string; readonly chartVersion: string; readonly appVersion?: string;
  readonly firstDeployed?: string; readonly lastDeployed?: string;
  readonly uid: string; readonly resourceVersion: string;
  readonly detail?: { readonly manifest?: string; readonly config?: string; readonly hooks?: string; readonly description?: string };
};
// Decode one Secret's `.data.release` per the pinned Helm v3 storage format. The gzipped payload
// is bounded BEFORE decompression and the inflated output bounded to 1 MiB; malformed or
// oversized entries are fixed rejections, never partial releases.
export function decodeHelmReleaseSecret(input: { readonly labels: unknown; readonly namespace: unknown; readonly dataRelease: string; readonly uid: unknown; readonly resourceVersion: unknown }, includeDetail = false): HelmReleaseRevision {
  const labels = helmReleaseSecretLabelsSchema.safeParse(input.labels);
  const uid = boundedName.safeParse(input.uid), resourceVersion = boundedName.safeParse(input.resourceVersion), namespace = namespaceName.safeParse(input.namespace);
  if (!labels.success || !uid.success || !resourceVersion.success || !namespace.success || typeof input.dataRelease !== 'string' || !input.dataRelease.length || input.dataRelease.length > 2_000_000) throw new BoundaryError('CONTENT_INVALID');
  let inner: string, inflated: Buffer;
  try {
    const outer = Buffer.from(input.dataRelease, 'base64');
    if (!outer.length || outer.length > helmReleaseMaxBytes || outer.toString('base64') !== input.dataRelease) throw new BoundaryError('CONTENT_INVALID');
    inner = outer.toString('utf8');
    const packed = Buffer.from(inner, 'base64');
    if (!packed.length || packed.length > helmReleaseMaxBytes) throw new BoundaryError('CONTENT_INVALID');
    inflated = gunzipSync(packed, { maxOutputLength: helmReleaseMaxBytes });
    if (!inflated.length || inflated.length > helmReleaseMaxBytes) throw new BoundaryError('CONTENT_INVALID');
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError('CONTENT_INVALID');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(inflated.toString('utf8')); } catch { throw new BoundaryError('CONTENT_INVALID'); }
  const release = releasePayloadSchema.safeParse(parsed);
  if (!release.success
    || release.data.name !== labels.data.name || release.data.namespace !== namespace.data
    || String(release.data.version) !== labels.data.version || release.data.info.status !== labels.data.status) throw new BoundaryError('CONTENT_INVALID');
  return Object.freeze({
    name: release.data.name, namespace: release.data.namespace, revision: release.data.version, status: release.data.info.status,
    chartName: release.data.chart.metadata.name, chartVersion: release.data.chart.metadata.version,
    ...(release.data.chart.metadata.appVersion !== undefined ? { appVersion: release.data.chart.metadata.appVersion } : {}),
    ...(release.data.info.first_deployed !== undefined ? { firstDeployed: release.data.info.first_deployed } : {}),
    ...(release.data.info.last_deployed !== undefined ? { lastDeployed: release.data.info.last_deployed } : {}),
    uid: uid.data, resourceVersion: resourceVersion.data,
    ...(includeDetail ? { detail: Object.freeze({
      ...(release.data.manifest !== undefined ? { manifest: release.data.manifest } : {}),
      ...(release.data.config !== undefined && release.data.config !== null ? { config: JSON.stringify(release.data.config).slice(0, 65_536) } : {}),
      ...(release.data.hooks !== undefined ? { hooks: JSON.stringify(release.data.hooks).slice(0, 65_536) } : {}),
      ...(release.data.info.description !== undefined ? { description: release.data.info.description } : {}),
    }) } : {}),
  });
}
// The Secret name is `sh.helm.release.v1.<release>.v<rev>` (Helm v3 storage driver contract).
export function helmReleaseSecretName(release: string, revision: number): string {
  return `sh.helm.release.v1.${release}.v${revision}`;
}

import type { TargetIdentity } from '../../shared/identity.ts';
import { readResponseJson } from './bounded-response.ts';
import type { ResourceReadTransport } from './resource-reader.ts';
const secretPageSchema = z.object({
  kind: z.literal('SecretList'), apiVersion: z.literal('v1'),
  metadata: z.object({ resourceVersion: z.string().min(1).max(256), continue: z.string().min(1).max(8192).optional() }).strict(),
  items: z.array(z.object({
    metadata: z.object({ name: z.string().min(1).max(253), namespace: namespaceName, uid: z.string().min(1).max(256), resourceVersion: z.string().min(1).max(256), labels: z.record(z.string(), z.string()).optional() }).strict(),
    type: z.literal('helm.sh/release.v1'),
    data: z.object({ release: z.string().min(1).max(2_000_000) }).strict(),
  }).strict()).max(100),
}).strict();
export type HelmReleaseSecretPage = { readonly revisions: readonly HelmReleaseRevision[]; readonly continueToken: string | null };
// Single-page bounded read (RX-D4): reads one limit=100 page of owner=helm Secrets with before/after target proof.
export async function readHelmReleaseSecretPage(
  target: TargetIdentity,
  signal: AbortSignal,
  read: ResourceReadTransport,
  verify: () => Promise<void>,
  options: { readonly continueToken?: string; readonly releaseName?: string } = {},
): Promise<HelmReleaseSecretPage> {
  await verify();
  const selector = options.releaseName === undefined ? 'owner=helm' : `owner=helm,name=${options.releaseName}`;
  const value = await readResponseJson(await read({
    method: 'GET', purpose: 'helm-releases', target,
    path: `/api/v1/namespaces/${target.namespace}/secrets`,
    query: { limit: '100', labelSelector: selector, ...(options.continueToken ? { continue: options.continueToken } : {}) },
    maximumBytes: 2_000_000,
  }, signal), signal);
  const page = secretPageSchema.safeParse(value);
  if (!page.success) throw new BoundaryError('RESOURCE_INVALID');
  const revisions: HelmReleaseRevision[] = [];
  for (const item of page.data.items) {
    const decoded = decodeHelmReleaseSecret({
      labels: item.metadata.labels,
      namespace: item.metadata.namespace,
      dataRelease: item.data.release,
      uid: item.metadata.uid,
      resourceVersion: item.metadata.resourceVersion,
    }, options.releaseName !== undefined);
    if (item.metadata.name !== helmReleaseSecretName(decoded.name, decoded.revision)) throw new BoundaryError('CONTENT_INVALID');
    revisions.push(decoded);
  }
  await verify();
  return Object.freeze({ revisions: Object.freeze(revisions), continueToken: page.data.metadata.continue ?? null });
}

export type HelmReleaseRevisions = { readonly revisions: readonly HelmReleaseRevision[]; readonly truncated: boolean };
// One bounded namespace read: at most 3 x 100 helm-owned Secrets, every entry decoded and
// provenance-checked in memory; the page continue token never leaves this call.
export async function readHelmReleaseRevisions(target: TargetIdentity, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>, releaseName?: string): Promise<HelmReleaseRevisions> {
  await verify();
  const selector = releaseName === undefined ? 'owner=helm' : `owner=helm,name=${releaseName}`;
  const revisions: HelmReleaseRevision[] = [];
  let continueToken: string | undefined, truncated = false, pages = 0;
  do {
    if (pages++ >= 3) { truncated = true; break; }
    const value = await readResponseJson(await read({ method: 'GET', purpose: 'helm-releases', target,
      path: `/api/v1/namespaces/${target.namespace}/secrets`, query: { limit: '100', labelSelector: selector, ...(continueToken ? { continue: continueToken } : {}) }, maximumBytes: 2_000_000 }, signal), signal);
    const page = secretPageSchema.safeParse(value);
    if (!page.success) throw new BoundaryError('RESOURCE_INVALID');
    for (const item of page.data.items) {
      const decoded = decodeHelmReleaseSecret({ labels: item.metadata.labels, namespace: item.metadata.namespace, dataRelease: item.data.release, uid: item.metadata.uid, resourceVersion: item.metadata.resourceVersion }, releaseName !== undefined);
      if (item.metadata.name !== helmReleaseSecretName(decoded.name, decoded.revision)) throw new BoundaryError('CONTENT_INVALID');
      revisions.push(decoded);
    }
    continueToken = page.data.metadata.continue;
  } while (continueToken);
  await verify();
  return Object.freeze({ revisions: Object.freeze(revisions), truncated });
}
