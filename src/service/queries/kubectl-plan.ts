import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { apiGroup, apiVersion, boundedName, containsControlCharacters, dnsName, namespaceName, resourceName } from '../../shared/identity.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import type { ResourceReadRequest } from './resource-reader.ts';
import { planLoadDocument } from './custom-document.ts';
import { customWatchReferenceSchema } from '../../shared/watch-protocol.ts';
import { manifestComparisonReferenceSchema, manifestComparisonPath } from '../../shared/manifest-diff-protocol.ts';
import { validateMetadataListRead } from './resource-list-representation.ts';

// Validate the client probe, not a supported-version range. gitVersion is an opaque
// label: older/newer, vendor and development builds must not be rejected by version.
export function verifyKubectlVersion(text: string): void {
  try {
    if (Buffer.byteLength(text) > 16_000) throw new Error('budget');
    const value = z.object({ clientVersion: z.object({ gitVersion: z.string().min(1).max(256)
      .refine(value => value.trim().length > 0 && !containsControlCharacters(value)) }) }).safeParse(JSON.parse(text) as unknown);
    if (!value.success) throw new Error('client probe');
  } catch { throw new BoundaryError('CLI_INCOMPATIBLE'); }
}

export function isolatedKubectlEnvironment(home: string, executablePath: string) {
  if (!home.startsWith('/') || home.startsWith('//') || !executablePath || home.includes('\0') || executablePath.includes('\0')) throw new BoundaryError('INVALID_INPUT');
  return Object.freeze({ PATH: executablePath, HOME: home, LANG: 'C', LC_ALL: 'C', KUBERC: 'off', KUBECTL_KUBERC: 'false' });
}

export function kubectlReadArguments(request: ResourceReadRequest, configurationPath: string): readonly string[] {
  if (request.representation !== undefined || request.customList !== undefined) throw new BoundaryError('INVALID_INPUT'); // No negotiated metadata proof in worker IPC.
  if (!configurationPath.startsWith('/') || configurationPath.startsWith('//') || containsControlCharacters(configurationPath)) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose !== 'custom-document' && request.customDocument !== undefined) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose !== 'custom-wide' && request.purpose !== 'custom-describe' && request.customInspection !== undefined) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose !== 'custom-resource-watch' && request.purpose !== 'custom-resource-relist' && request.customWatch !== undefined) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose !== 'manifest-diff' && request.comparison !== undefined) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose !== 'manifest-create-proof' && request.createReference !== undefined) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose === 'manifest-create-proof') {
    const reference = manifestComparisonReferenceSchema.safeParse(request.createReference);
    if (!reference.success || request.method !== 'GET' || request.path !== manifestComparisonPath(reference.data) || request.maximumBytes !== 2_000_000
      || Object.keys(request.query).length || !boundedName.safeParse(request.target.context).success) throw new BoundaryError('INVALID_INPUT');
    return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${request.target.context}`, '--request-timeout=7s', '--profile=none', '--v=0', 'get', `--raw=${request.path}`]);
  }
  if (request.purpose === 'manifest-diff') {
    const reference = manifestComparisonReferenceSchema.safeParse(request.comparison);
    if (!reference.success || request.method !== 'GET' || request.path !== manifestComparisonPath(reference.data) || request.maximumBytes !== 2_000_000
      || Object.keys(request.query).length || !boundedName.safeParse(request.target.context).success) throw new BoundaryError('INVALID_INPUT');
    return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${request.target.context}`, '--request-timeout=7s', '--profile=none', '--v=0', 'get', `--raw=${request.path}`]);
  }
  if (request.purpose === 'openapi-index' || request.purpose === 'openapi-schema') {
    const parts = request.path.split('/'), group = parts[3] === 'apis' ? parts[4] : '', version = parts[3] === 'apis' ? parts[5] : parts[4];
    const validPath = parts[0] === '' && parts[1] === 'openapi' && parts[2] === 'v3'
      && (parts[3] === 'api' ? parts.length === 5 : parts[3] === 'apis' && parts.length === 6 && !!group && apiGroup.safeParse(group).success)
      && apiVersion.safeParse(version).success;
    if (request.method !== 'GET' || (request.purpose === 'openapi-index' ? request.path !== '/openapi/v3' || request.maximumBytes !== 2_000_000 || Object.keys(request.query).length !== 0
      : !validPath || request.maximumBytes !== 8_000_000 || Object.keys(request.query).length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(request.query.hash ?? ''))
      || !boundedName.safeParse(request.target.context).success) throw new BoundaryError('INVALID_INPUT');
    const query = new URLSearchParams(request.query).toString();
    return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${request.target.context}`, '--request-timeout=7s', '--profile=none', '--v=0', 'get', `--raw=${request.path}${query ? `?${query}` : ''}`]);
  }
  if (request.purpose === 'api-root' && request.path !== '/apis') throw new BoundaryError('INVALID_INPUT');
  const parts = request.path.split('/').slice(1);
  let remaining: string[];
  if (request.purpose === 'api-root' && request.path === '/apis') remaining = [];
  else if (parts[0] === 'api' && parts[1] && apiVersion.safeParse(parts[1]).success) remaining = parts.slice(2);
  else if (parts[0] === 'apis' && parts[1] && apiGroup.safeParse(parts[1]).success) {
    if (request.purpose === 'api-group' && parts.length === 2) remaining = [];
    else if (parts[2] && apiVersion.safeParse(parts[2]).success) remaining = parts.slice(3);
    else throw new BoundaryError('INVALID_INPUT');
  } else throw new BoundaryError('INVALID_INPUT');
  if (request.method !== 'GET' || request.path.includes('%') || request.maximumBytes !== 2_000_000) throw new BoundaryError('INVALID_INPUT');
  const eventApi = parts[0] === 'api' && parts[1] === 'v1' || parts[0] === 'apis' && parts[1] === 'events.k8s.io' && parts[2] === 'v1';
  if (request.purpose === 'custom-resource-watch' || request.purpose === 'custom-resource-relist') {
    const custom = customWatchReferenceSchema.safeParse(request.customWatch); if (!custom.success) throw new BoundaryError('INVALID_INPUT');
    const { type } = custom.data, expected = `/apis/${type.group}/${type.version}${type.scope === 'namespace' ? `/namespaces/${request.target.namespace}` : ''}/${type.resource}`;
    if (request.path !== expected) throw new BoundaryError('INVALID_INPUT');
    const watch = request.purpose === 'custom-resource-watch', keys = watch ? ['watch', 'resourceVersion', 'timeoutSeconds', 'fieldSelector'] : ['limit', 'continue', 'fieldSelector'];
    if (Object.keys(request.query).some(key => !keys.includes(key))) throw new BoundaryError('INVALID_INPUT');
    if (watch ? request.query.watch !== 'true' || request.query.timeoutSeconds !== '5' || !boundedName.safeParse(request.query.resourceVersion).success || request.query.resourceVersion === '0'
      : request.query.limit !== '100') throw new BoundaryError('INVALID_INPUT');
    const selector = request.query.fieldSelector, continuation = request.query.continue;
    if (selector !== undefined && (!selector.startsWith('metadata.name=') || !dnsName.safeParse(selector.slice('metadata.name='.length)).success)
      || continuation !== undefined && (!continuation || continuation.length > 8192 || containsControlCharacters(continuation))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'job-pod-watch') {
    if (parts[0] !== 'api' || parts[1] !== 'v1' || remaining.length !== 3 || remaining[0] !== 'namespaces' || remaining[1] !== request.target.namespace || remaining[2] !== 'pods'
      || request.query.watch !== 'true' || request.query.timeoutSeconds !== '5' || !boundedName.safeParse(request.query.resourceVersion).success || request.query.resourceVersion === '0'
      || !request.query.labelSelector || request.query.labelSelector.length > 8192 || containsControlCharacters(request.query.labelSelector)
      || Object.keys(request.query).length !== 4 || Object.keys(request.query).some(key => !['watch', 'resourceVersion', 'timeoutSeconds', 'labelSelector'].includes(key))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'namespace-event-watch') {
    if (!eventApi || remaining.length !== 3 || remaining[0] !== 'namespaces' || !namespaceName.safeParse(remaining[1]).success || remaining[2] !== 'events'
      || request.query.watch !== 'true' || request.query.timeoutSeconds !== '5' || !boundedName.safeParse(request.query.resourceVersion).success || request.query.resourceVersion === '0'
      || Object.keys(request.query).length !== 3 || Object.keys(request.query).some(key => !['watch', 'resourceVersion', 'timeoutSeconds'].includes(key))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'resource-watch') {
    const namespaced = remaining.length === 3 && remaining[0] === 'namespaces', resource = remaining[namespaced ? 2 : 0];
    const group = parts[0] === 'apis' ? parts[1] : '', version = parts[0] === 'apis' ? parts[2] : parts[1];
    const descriptor = Object.values(resourceDescriptors).find(type => type.group === group && type.version === version && type.resource === resource);
    if (!descriptor || (descriptor.scope === 'namespace') !== namespaced || (namespaced ? remaining[1] !== request.target.namespace : remaining.length !== 1)
      || request.query.watch !== 'true' || request.query.timeoutSeconds !== '5' || !boundedName.safeParse(request.query.resourceVersion).success || request.query.resourceVersion === '0'
      || Object.keys(request.query).some(key => !['watch', 'resourceVersion', 'timeoutSeconds', 'fieldSelector'].includes(key))) throw new BoundaryError('INVALID_INPUT');
    const selector = request.query.fieldSelector;
    if (selector !== undefined && (!selector.startsWith('metadata.name=') || !dnsName.safeParse(selector.slice('metadata.name='.length)).success)) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'helm-releases') {
    // D-01 approved read path: only the helm release Secret listing in the target namespace,
    // fixed label selector, fixed page size; every other path/selector stays invalid.
    if (parts[0] !== 'api' || parts[1] !== 'v1' || remaining.length !== 3 || remaining[0] !== 'namespaces' || remaining[1] !== request.target.namespace || remaining[2] !== 'secrets'
      || request.query.limit !== '100' || !(request.query.labelSelector === 'owner=helm' || /^owner=helm,name=[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(request.query.labelSelector ?? ''))
      || Object.keys(request.query).some(key => !['limit', 'labelSelector', 'continue'].includes(key))) throw new BoundaryError('INVALID_INPUT');
    const continuation = request.query.continue;
    if (continuation !== undefined && (!continuation || continuation.length > 8192 || containsControlCharacters(continuation))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'cluster-info') {
    if (request.path !== '/api/v1/namespaces/kube-system/services' || Object.keys(request.query).length) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'api-version' || request.purpose === 'api-group' || request.purpose === 'api-root') {
    if (remaining.length || Object.keys(request.query).length) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'namespace-inventory') {
    if (remaining.length !== 3 || remaining[0] !== 'namespaces' || !namespaceName.safeParse(remaining[1]).success || !resourceName.safeParse(remaining[2]).success
      || request.query.limit !== '100' || Object.keys(request.query).some(key => !['limit', 'continue'].includes(key))) throw new BoundaryError('INVALID_INPUT');
    const value = request.query.continue; if (value !== undefined && (!value || value.length > 8192 || containsControlCharacters(value))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'namespace-events') {
    if (!eventApi || remaining.length !== 3 || remaining[0] !== 'namespaces' || !namespaceName.safeParse(remaining[1]).success
      || remaining[2] !== 'events' || request.query.limit !== '100' || Object.keys(request.query).some(key => !['limit', 'continue'].includes(key))) throw new BoundaryError('INVALID_INPUT');
    const continuation = request.query.continue;
    if (continuation !== undefined && (!continuation || continuation.length > 8192 || containsControlCharacters(continuation))) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'pod-logs' || request.purpose === 'pod-log-follow') {
    if (parts[0] !== 'api' || parts[1] !== 'v1' || remaining.length !== 5 || remaining[0] !== 'namespaces' || !namespaceName.safeParse(remaining[1]).success
      || remaining[2] !== 'pods' || !dnsName.safeParse(remaining[3]).success || remaining[4] !== 'log'
      || !namespaceName.safeParse(request.query.container).success || !['true', 'false'].includes(request.query.timestamps ?? '')) throw new BoundaryError('INVALID_INPUT');
    const follow = request.purpose === 'pod-log-follow';
    if (follow && request.query.follow !== 'true') throw new BoundaryError('INVALID_INPUT');
    if (Object.keys(request.query).some(key => !(follow ? ['container', 'timestamps', 'sinceSeconds', 'tailLines', 'follow'] : ['container', 'timestamps', 'sinceSeconds', 'tailLines']).includes(key))) throw new BoundaryError('INVALID_INPUT');
    for (const [name, maximum] of [['sinceSeconds', 31_536_000], ['tailLines', 1_000_000]] as const) {
      const value = request.query[name];
      if (value !== undefined && (!/^[1-9]\d{0,7}$/.test(value) || Number(value) > maximum)) throw new BoundaryError('INVALID_INPUT');
    }
  } else if (request.purpose === 'custom-wide' || request.purpose === 'custom-describe') {
    const plan = planLoadDocument(request.customInspection, request.target);
    if (!plan.custom || request.path !== plan.path || Object.keys(request.query).length) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'custom-document') {
    // A separate GET-only purpose binds the exact selected CRD reference/path. Builtin object/printer admission stays closed.
    const plan = planLoadDocument(request.customDocument, request.target);
    if (!plan.custom || request.path !== plan.path || Object.keys(request.query).length) throw new BoundaryError('INVALID_INPUT');
  } else if (request.purpose === 'resource-object' || request.purpose === 'resource-wide' || request.purpose === 'resource-describe') {
    if (Object.keys(request.query).length) throw new BoundaryError('INVALID_INPUT');
    const namespaced = remaining.length === 4 && remaining[0] === 'namespaces';
    const namespace = namespaced ? remaining[1] : undefined;
    const resource = remaining[namespaced ? 2 : 0], name = remaining[namespaced ? 3 : 1];
    if ((namespaced ? !namespaceName.safeParse(namespace).success : remaining.length !== 2) || !dnsName.safeParse(name).success) throw new BoundaryError('INVALID_INPUT');
    const group = parts[0] === 'apis' ? parts[1] : '', version = parts[0] === 'apis' ? parts[2] : parts[1];
    const descriptor = Object.values(resourceDescriptors).find(type => type.group === group && type.version === version && type.resource === resource);
    const definition = group === 'apiextensions.k8s.io' && version === 'v1' && resource === 'customresourcedefinitions' && !namespaced;
    if ((!definition || request.purpose !== 'resource-object') && (!descriptor || (descriptor.scope === 'namespace') !== namespaced
      || (namespaced && namespace !== request.target.namespace && !(group === '' && resource === 'pods')))) throw new BoundaryError('INVALID_INPUT');
  } else {
    if (remaining[0] === 'namespaces' && remaining.length === 3) {
      if (!namespaceName.safeParse(remaining[1]).success || remaining[1] !== request.target.namespace) throw new BoundaryError('INVALID_INPUT');
      remaining = remaining.slice(2);
    }
    if (remaining.length !== 1 || !resourceName.safeParse(remaining[0]).success || !/^([1-9]|[1-9]\d|100)$/.test(request.query.limit ?? '')) throw new BoundaryError('INVALID_INPUT');
    if (request.purpose === 'custom-resource-definitions' && request.path !== '/apis/apiextensions.k8s.io/v1/customresourcedefinitions') throw new BoundaryError('INVALID_INPUT');
    if (Object.keys(request.query).some(key => !['limit', 'continue', 'labelSelector', 'fieldSelector'].includes(key))) throw new BoundaryError('INVALID_INPUT');
    for (const value of Object.values(request.query)) if (value.length > 8192 || containsControlCharacters(value)) throw new BoundaryError('INVALID_INPUT');
  }
  const target = boundedName.safeParse(request.target.context);
  if (!target.success) throw new BoundaryError('INVALID_INPUT');
  if (request.purpose === 'cluster-info') {
    return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${target.data}`, '--namespace=kube-system',
      '--cache-dir=/dev/null', '--request-timeout=7s', '--profile=none', '--v=0', 'cluster-info']);
  }
  if (request.purpose === 'resource-wide' || request.purpose === 'resource-describe' || request.purpose === 'custom-wide' || request.purpose === 'custom-describe') {
    const namespaced = remaining.length === 4, resource = remaining[namespaced ? 2 : 0], name = remaining[namespaced ? 3 : 1];
    const group = parts[0] === 'apis' ? parts[1] : '', version = parts[0] === 'apis' ? parts[2] : parts[1];
    // A single fully-qualified TYPE/NAME prevents Describe's two-argument prefix fallback.
    const qualified = `${resource}.${version}.${group}/${name}`;
    const wide = request.purpose === 'resource-wide' || request.purpose === 'custom-wide';
    return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${target.data}`, `--namespace=${namespaced ? remaining[1] : request.target.namespace}`,
      '--cache-dir=/dev/null', '--request-timeout=7s', '--profile=none', '--v=0', wide ? 'get' : 'describe', qualified,
      ...(wide ? ['--output=wide', '--server-print=true'] : ['--show-events=true']), '--chunk-size=100']);
  }
  const query = new URLSearchParams(request.query).toString();
  return Object.freeze([`--kubeconfig=${configurationPath}`, `--context=${target.data}`, request.purpose === 'pod-log-follow' ? '--request-timeout=50s' : '--request-timeout=7s', '--profile=none', '--v=0', 'get', `--raw=${request.path}${query ? `?${query}` : ''}`]);
}

export function validateKubectlReadRequest(request: ResourceReadRequest): void {
  kubectlReadArguments(request, '/validation/configuration.pipe'); // Pure validation only; no process uses this path.
}

export function validateResourceReadTransportRequest(request: ResourceReadRequest): void {
  if (request.representation !== undefined) validateMetadataListRead(request);
  else validateKubectlReadRequest(request);
}

export function kubectlFailureStatus(stderr: string): 401 | 403 | 404 | 410 | 429 | 500 {
  const reason = /^Error from server \((Unauthorized|Forbidden|NotFound|Gone|Expired|TooManyRequests)\):/m.exec(stderr)?.[1];
  const statuses: Readonly<Record<string, 401 | 403 | 404 | 410 | 429>> = { Unauthorized: 401, Forbidden: 403, NotFound: 404, Gone: 410, Expired: 410, TooManyRequests: 429 };
  return reason ? statuses[reason] ?? 500 : 500;
}

// Extracts an explicit retry-after duration only when the server error message exposes it; never fabricates one.
export function kubectlRetryAfterMs(stderr: string): number | undefined {
  const match = /\bretry after (\d+)s\b/i.exec(stderr);
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(60_000, seconds * 1000);
}
