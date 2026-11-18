// M7/M6 deferred-command completion: LocalTunnel provider resolution (upstream ships NO
// built-in provider — the registry is extension-fed and empty in single-plugin scope), helm
// template preview (single-template --show-only render), the in-scope cluster provider list
// (built-in minikube; cloud providers delegate to excluded cloud extensions), and the bounded
// minikube kubeconfig read feeding the EXPLICIT M4-E030 merge confirmation. Static review only.
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { workspaceRootSchema, workspaceRelativeSchema, workspaceProofSchema } from '../../shared/workspace-protocol.ts';
import { templateFailureCode } from '../../shared/helm-template-protocol.ts';
import { skipsYamlValidation, templateArguments } from '../../shared/helm-template-preview-protocol.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { HelmTemplatePreviewRun } from '../adapters/helm-template-cli.ts';
import type { MinikubeCliRunner } from '../adapters/minikube-cli.ts';
import { analyseManifestBundle } from '../../parsing/manifest-bundle.ts';
import { publicConfigSummary } from '../queries/kubeconfig.ts';

export const providerFlowRequestSchema = z.discriminatedUnion('kind', [
  // Upstream startLocalTunnelDebugSession: configured setting otherwise the first sorted id.
  z.object({ protocol: z.literal(2), kind: z.literal('local-tunnel-start'), configuredProvider: z.string().min(1).max(128).optional() }).strict(),
  // Upstream template preview: an explicit workspace template file; the render attributes the
  // chart by the fixed structural rule (parent of the templates/ segment, disclosed bound).
  z.object({ protocol: z.literal(2), kind: z.literal('template-preview'), root: workspaceRootSchema, path: workspaceRelativeSchema.refine(value => value.includes('/templates/')), fileProof: workspaceProofSchema }).strict(),
  // Upstream cluster wizard provider list per action.
  z.object({ protocol: z.literal(2), kind: z.literal('cluster-providers'), action: z.enum(['create', 'configure']) }).strict(),
  // Upstream minikube configure leg: bounded read for the EXPLICIT merge confirmation.
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-config-view') }).strict(),
]);
export type ProviderFlowRequest = z.infer<typeof providerFlowRequestSchema>;
export const providerFlowResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('no-provider-installed'), message: z.string().max(256) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('configured-provider-missing'), providerId: z.string().max(128), message: z.string().max(256) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('template-previewed'), text: z.string().max(262_144) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('preview-unavailable'), code: z.enum(['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'CONTENT_INVALID', 'STATE_UNAVAILABLE', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED'] as const) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cluster-providers'), providers: z.array(z.object({ id: z.string().max(128), actions: z.array(z.enum(['create', 'configure'])).max(2) }).strict()).max(8) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-config'), currentContext: z.string().max(1024),
    contexts: z.array(z.object({ name: z.string().max(1024), clusterName: z.string().max(1024), namespace: z.string().max(63) }).strict()).max(5000) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('flow-unavailable'), code: z.string().max(64) }).strict(),
]);
export type ProviderFlowResponse = z.infer<typeof providerFlowResponseSchema>;
// The upstream provider registry is fed by EXTERNAL extensions; the fixed upstream extension
// registers none itself, so in single-plugin scope the registry is EMPTY and the two upstream
// prompts are the exact in-scope behavior.
export const inScopeLocalTunnelProviders: readonly string[] = Object.freeze([]);
export const inScopeClusterProviders = Object.freeze([{ id: 'minikube', actions: ['create', 'configure'] as const }]);
export function localTunnelConfiguredMissingMessage(name: string): string {
  return `You have configured VSCode to use Local Tunnel debugger '${name}', but it is not installed.`;
}
export function localTunnelNoneInstalledMessage(): string {
  return 'You do not have a Local Tunnel Debug Provider installed.';
}
// The chart directory is the parent of the templates/ segment (upstream walks to Chart.yaml; the
// bounded structural equivalent, disclosed).
export function chartDirectoryFor(path: string): string {
  const index = path.indexOf('/templates/');
  if (index < 0) throw new BoundaryError('CONTENT_INVALID'); // upstream: Not a template
  return path.slice(0, index);
}
export function relativeTemplateFor(path: string): string {
  const index = path.indexOf('/templates/') + '/templates/'.length;
  if (index >= path.length) throw new BoundaryError('CONTENT_INVALID');
  return path.slice(index);
}

export function createProviderFlowOperations(options: { workspace: Pick<ReturnType<typeof createWorkspaceReader>, 'rebind' | 'capture' | 'release'>;
  previewRun: HelmTemplatePreviewRun; syntax: (signal: AbortSignal) => Promise<2 | 3 | 4>; minikube: MinikubeCliRunner }) {
  let closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ProviderFlowResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = providerFlowRequestSchema.parse(input);
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'local-tunnel-start') {
        const providerName = request.configuredProvider ?? [...inScopeLocalTunnelProviders].sort()[0];
        if (providerName && !inScopeLocalTunnelProviders.includes(providerName)) return { protocol: 2, kind: 'configured-provider-missing', providerId: providerName.slice(0, 128), message: localTunnelConfiguredMissingMessage(providerName).slice(0, 256) };
        return { protocol: 2, kind: 'no-provider-installed', message: localTunnelNoneInstalledMessage() };
      }
      if (request.kind === 'cluster-providers') {
        const providers = inScopeClusterProviders.filter(provider => (provider.actions as readonly string[]).includes(request.action));
        return { protocol: 2, kind: 'cluster-providers', providers: providers.map(provider => ({ id: provider.id, actions: [...provider.actions] })) };
      }
      if (request.kind === 'template-preview') {
        // Fresh proof of the exact template file before any render; the preview always renders
        // the CURRENT file, never a stale path (the captured bytes bound the render's input).
        const scope = await options.workspace.rebind({ protocol: 2, root: request.root, path: request.path, proof: request.fileProof }, signal);
        try {
          const captured = await options.workspace.capture({ protocol: 2, scope: scope.scope, path: request.path }, signal);
          if (Buffer.byteLength(captured.text) > 262_144) throw new BoundaryError('BUDGET_EXCEEDED');
          const chartPath = chartDirectoryFor(request.path), relative = relativeTemplateFor(request.path);
          const version = await options.syntax(signal);
          const text = await options.previewRun({ root: request.root, chartPath, relativeTemplate: relative, version }, signal);
          if (!text.trim()) return { protocol: 2, kind: 'preview-unavailable', code: 'CONTENT_INVALID' }; // upstream: no output
          if (!skipsYamlValidation(relative)) { try { analyseManifestBundle(text, 'yaml'); } catch { return { protocol: 2, kind: 'preview-unavailable', code: 'CONTENT_INVALID' }; } } // upstream: YAML failed to parse
          return { protocol: 2, kind: 'template-previewed', text };
        } catch (error) {
          const code = templateFailureCode(error);
          return { protocol: 2, kind: 'preview-unavailable', code: ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED'].includes(code) ? code as 'CLI_NOT_FOUND' | 'CLI_INCOMPATIBLE' | 'QUERY_CANCELLED' | 'BUDGET_EXCEEDED' : code === 'CONTENT_INVALID' ? 'CONTENT_INVALID' : 'STATE_UNAVAILABLE' };
        } finally {
          try { options.workspace.release({ protocol: 2, scope: scope.scope }); } catch { /* scope expiry */ }
        }
      }
      if (request.kind === 'minikube-config-view') {
        const probe = await options.minikube.kubectlConfigView(signal);
        if (probe === undefined) return { protocol: 2, kind: 'flow-unavailable', code: 'CLI_NOT_FOUND' };
        if (probe.code !== 0 || !probe.stdout.trim()) return { protocol: 2, kind: 'flow-unavailable', code: 'STATE_UNAVAILABLE' };
        // publicConfigSummary enforces 48_000 bytes before parsing; never return raw stdout.
        return { protocol: 2, kind: 'minikube-config', ...publicConfigSummary(probe.stdout) };
      }
      throw new BoundaryError('INVALID_INPUT');
    },
    close() { closed = true; },
  };
}
export { templateArguments };
