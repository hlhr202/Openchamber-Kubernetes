import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import { parseAst } from 'rolldown/parseAst';
import { z } from 'zod';
import { contentManifest, filesBelow, inputFingerprint, manifestHash } from './build-input.ts';
import { requireDevelopmentContainer } from './development.ts';
import { readonlyTestFiles } from './readonly-tests.ts';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(node: Record<string, unknown> | null | undefined): unknown {
  if (node?.type !== 'TemplateLiteral') return node?.value;
  if (!Array.isArray(node.expressions) || node.expressions.length !== 0 || !Array.isArray(node.quasis)) return undefined;
  return record(record(node.quasis[0])?.value)?.cooked;
}

function visit(value: unknown, inspect: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const item of value) visit(item, inspect); return; }
  const node = record(value);
  if (!node) return;
  if (typeof node.type === 'string') inspect(node);
  for (const [key, child] of Object.entries(node)) if (!['loc', 'range', 'start', 'end'].includes(key)) visit(child, inspect);
}

export async function verifySourceBoundaries(): Promise<void> {
  const sources = (await filesBelow('src')).filter(file => file.endsWith('.ts'));
  const readonlyRoots = (await filesBelow('tests/readonly')).filter(file => file.endsWith('.ts'));
  assert.deepEqual(readonlyRoots.map(file => relative(process.cwd(), file).replaceAll('\\', '/')).sort(), [...readonlyTestFiles].sort(), 'Read-only suites must be explicitly reviewed and allowlisted');
  const graph = new Map<string, string[]>();
  for (const file of [...sources, ...readonlyRoots]) {
    const path = relative(process.cwd(), file).replaceAll('\\', '/');
    const code = await readFile(file, 'utf8');
    const program = parseAst(code, { lang: 'ts', astType: 'ts' }, path);
    const edges: string[] = [];
    graph.set(path, edges);
    visit(program, node => {
      if (node.type === 'ImportExpression') throw new Error(`Unreviewed dynamic import: ${path}`);
      if (node.type === 'CallExpression' && record(node.callee)?.name === 'require') throw new Error(`Unreviewed runtime require: ${path}`);
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(String(node.type))) return;
      const specifier = record(node.source)?.value;
      if (typeof specifier !== 'string') return;
      const resolved = specifier.startsWith('.') ? relative(process.cwd(), resolve(dirname(file), specifier)).replaceAll('\\', '/') : specifier;
      if (specifier.startsWith('.')) {
        if (!resolved.startsWith('src/') && !resolved.startsWith('tests/readonly/')) throw new Error(`Source dependency outside reviewed roots: ${path}`);
        edges.push(resolved);
      }
      const protectedReadPath = path.startsWith('src/shared/') || path.startsWith('src/parsing/') || path.startsWith('src/panel/') || path.startsWith('src/host/') || path.startsWith('src/service/queries/') || path.startsWith('tests/readonly/');
      if (protectedReadPath && resolved === 'src/service/adapters/automatic-credentials.ts') throw new Error(`Read/display imports authentication executor: ${path}`);
      if (protectedReadPath && resolved === 'src/service/adapters/metadata-list-https.ts') throw new Error(`Read/display imports metadata transport executor: ${path}`);
      if (protectedReadPath && /src\/service\/(operations|sessions|runtime)\//.test(resolved)) throw new Error(`Read/display imports an executor: ${path}`);
        if (protectedReadPath && /^src\/service\/adapters\/(kubectl-delete|delete-worker|namespace-file|preference-store|workspace-file-write|kubectl-manifest-create|manifest-create-worker|manifest-apply-https|https-once|scale-https|cronjob-run-https|expose-https|config-file-delete-https|config-file-add-https|file-delete-https|helm-version-cli|helm-repo-refresh-cli|helm-inspect-cli|helm-values-cli|helm-dependencies-cli|helm-lint-cli|helm-template-cli|helm-dryrun-cli|helm-package-cli|helm-depup-cli|helm-create-cli|helm-fetch-cli|helm-template-write|exec-credential|apply-file-https|image-run-cli|git-cli|k8s-websocket|helm-cluster-cli|merge-kubeconfig-file|minikube-cli|telepresence-cli)\.ts$/.test(resolved)) throw new Error(`Read/display imports a write adapter: ${path}`);
      if (path.startsWith('src/shared/') && !(resolved.startsWith('src/shared/') || specifier === 'zod')) throw new Error(`Nonportable shared dependency: ${path}`);
      if (path.startsWith('src/parsing/') && !(resolved.startsWith('src/parsing/') || resolved.startsWith('src/shared/') || specifier === 'yaml')) throw new Error(`Nonportable parser dependency: ${path}`);
      if ((path.startsWith('src/panel/') || path.startsWith('src/host/')) && (resolved.startsWith('src/service/') || isBuiltin(specifier))) throw new Error(`Server dependency in panel: ${path}`);
    });
  }
  // Check the complete graph too: a read -> adapter -> write edge must not bypass a direct-import rule.
  for (const root of graph.keys()) {
    if (!/^(src\/(shared|parsing|panel|host|service\/queries)\/|tests\/readonly\/)/.test(root)) continue;
    const visited = new Set<string>();
    const queue = [root];
    while (queue.length) {
      const path = queue.pop();
      if (!path || visited.has(path)) continue;
      visited.add(path);
      if (path === 'src/service/adapters/automatic-credentials.ts') throw new Error(`Read/display graph reaches authentication executor: ${root} -> ${path}`);
      if (path === 'src/service/adapters/metadata-list-https.ts') throw new Error(`Read/display graph reaches metadata transport executor: ${root} -> ${path}`);
       if (/^src\/service\/(operations|sessions|runtime)\//.test(path)
           || /^src\/service\/adapters\/(kubectl-delete|delete-worker|namespace-file|preference-store|workspace-file-write|kubectl-manifest-create|manifest-create-worker|manifest-apply-https|https-once|scale-https|cronjob-run-https|expose-https|config-file-delete-https|config-file-add-https|file-delete-https|helm-repo-refresh-cli|helm-inspect-cli|helm-values-cli|helm-dependencies-cli|helm-lint-cli|helm-template-cli|helm-dryrun-cli|helm-package-cli|helm-depup-cli|helm-create-cli|helm-fetch-cli|helm-template-write|exec-credential|apply-file-https|image-run-cli|git-cli|k8s-websocket|helm-cluster-cli|merge-kubeconfig-file|minikube-cli|telepresence-cli)\.ts$/.test(path)
           || (root.startsWith('tests/readonly/') && /^src\/(host\/(delete-client|namespace-client|namespace-delete-client|context-client|context-delete-client|preference-client|preference-transport|file-save-client|manifest-create-client|manifest-apply-client|scale-client|cronjob-run-client|expose-client|config-file-delete-client|config-file-add-client|file-delete-client|helm-refresh-client|helm-inspect-client|helm-values-client|helm-dependencies-client|helm-lint-client|helm-template-client|helm-dryrun-client|helm-package-client|helm-depup-client|helm-create-client|helm-fetch-client|helm-requirement-client|helm-convert-client|helm-parameterise-client|apply-file-client|helm-release-client|image-run-client|git-sync-client|session-client|helm-write-client|merge-kubeconfig-client|cluster-client)|panel\/(delete-(actions|view)|namespace-view|namespace-delete-view|context-view|context-delete-view|preference-view|file-save-view|manifest-create-view|manifest-apply-view|scale-view|cronjob-run-view|expose-view|config-file-delete-view|config-file-add-view|file-delete-view|helm-refresh-view|helm-inspect-view|helm-values-view|helm-dependencies-view|helm-lint-view|helm-template-view|helm-dryrun-view|helm-package-view|helm-depup-view|helm-create-view|helm-fetch-view|helm-requirement-view|helm-convert-view|helm-parameterise-view|apply-file-view|helm-release-view|image-run-view|git-sync-view|terminal-session-view|exec-forward-dashboard-view|tree-view|merge-kubeconfig-view|cluster-view|sessions-debug-view))\.ts$/.test(path))
        || (root.startsWith('tests/readonly/') && path === 'src/panel/entry.ts')) throw new Error(`Read/display graph reaches executable entry: ${root} -> ${path}`);
      const edges = graph.get(path);
      if (!edges) throw new Error(`Unreviewed local dependency: ${root} -> ${path}`);
      queue.push(...edges);
    }
  }
}

export function verifyBundlePaths(code: string, profile: 'release' | 'development' = 'release'): void {
  let inspected = code;
  if (profile === 'development') {
    // Only generated, relative dependency source-marker comments are exempted.
    // Literal/template content is independently checked, so a marker-looking line
    // inside a string cannot hide a runtime path. Release has NO exemption.
    visit(parseAst(code, null, 'bundle.js'), node => {
      if (node.type === 'Literal' && typeof node.value === 'string') assert.ok(!/\/Users\/|\/workspace\//.test(node.value), 'Machine path in development literal');
      if (node.type === 'TemplateElement') assert.ok(!/\/Users\/|\/workspace\//.test(String(record(node.value)?.raw ?? '')), 'Machine path in development template');
    });
    inspected = code.replace(/^\/\/ (?:\.\.\/)+workspace\/node_modules\/[^\r\n]+$/gm, '');
  }
  assert.ok(!inspected.includes('/Users/') && !inspected.includes('/workspace/'), 'Absolute build path in bundle');
}

export function verifyBrowserEnvironment(code: string): void {
  const property = (node: Record<string, unknown>, name: string) => {
    const value = record(node.property);
    return node.computed ? value?.type === 'Literal' && value.value === name : value?.type === 'Identifier' && value.name === name;
  };
  visit(parseAst(code, null, 'panel.js'), node => {
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value.startsWith('node:') && isBuiltin(node.value)) throw new Error('Node builtin in browser bundle');
    if (node.type !== 'MemberExpression' || !property(node, 'env')) return;
    const object = record(node.object), global = record(object?.object);
    if ((object?.type === 'Identifier' && object.name === 'process')
      || (object?.type === 'MemberExpression' && property(object, 'process') && global?.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(String(global.name)))) throw new Error('Node environment in browser bundle');
  });
}

async function verifyPackageProfile(directory: string, profile: 'release' | 'development'): Promise<void> {
  const manifest = await readFile(resolve(directory, 'package.json'), 'utf8');
  const parsed = parseManifestJson(manifest);
  if (!parsed.ok) throw new Error(`SDK rejected package manifest: ${parsed.code}`);
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(manifest) as unknown);
  const html = await readFile(resolve(directory, 'panel/index.html'), 'utf8');
  assert.match(html, /<script src="\.\/main\.js"><\/script>/);
  assert.ok(!/<script[^>]+type=["']module|https?:\/\//i.test(html));
  for (const path of ['panel/main.css', 'panel/icon.svg', 'service/main.js']) assert.ok((await readFile(resolve(directory, path))).byteLength > 0);
  for (const [path, panel] of [['panel/main.js', true], ['service/main.js', false]] as const) {
    const code = await readFile(resolve(directory, path), 'utf8');
    const ast = parseAst(code, null, path);
    let healthVersionMatches = false;
    visit(ast, node => {
      if (!panel && node.type === 'Identifier' && node.name === '__K8S_EXTENSION_VERSION__') throw new Error('Missing service release version');
      if (!panel && node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
        const fields = new Map(node.properties.flatMap(property => {
          const field = record(property), key = record(field?.key);
          return field?.type === 'Property' && key?.type === 'Identifier' ? [[key.name, record(field.value)] as const] : [];
        }));
        if (stringValue(fields.get('status')) === 'ready' && fields.has('serviceGeneration') && fields.has('compatibility') && fields.has('protocol')) {
          assert.equal(stringValue(fields.get('version')), version, 'Service health version differs from package manifest');
          healthVersionMatches = true;
        }
      }
      if (node.type === 'ImportExpression') throw new Error('Unreviewed runtime module loading in bundle');
      if (node.type === 'ImportDeclaration') {
        const source = record(node.source)?.value;
        if (panel || typeof source !== 'string' || !isBuiltin(source)) throw new Error('Unexpected external bundle dependency');
      }
      if (panel && ['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(String(node.type))) throw new Error('Panel is not classic IIFE');
    });
    if (!panel) assert.ok(healthVersionMatches, 'Missing versioned service health response');
    if (panel) verifyBrowserEnvironment(code);
    verifyBundlePaths(code, profile);
    if (profile === 'development') {
      assert.match(code, /\n\/\/# sourceMappingURL=main\.js\.map\s*$/);
      const map = z.object({ version: z.literal(3), sources: z.array(z.string()).min(1), sourcesContent: z.array(z.string()), mappings: z.string().min(1) })
        .parse(JSON.parse(await readFile(resolve(directory, `${path}.map`), 'utf8')) as unknown);
      assert.equal(map.sources.length, map.sourcesContent.length);
      for (const source of map.sources) assert.match(source, /^(project\/src\/|dependencies\/)/, 'Unexpected development source map path');
    }
  }
}

export async function verifyPackage(directory: string): Promise<void> { await verifyPackageProfile(directory, 'release'); }
export async function verifyDevelopmentPackage(directory: string): Promise<void> { await verifyPackageProfile(directory, 'development'); }

const candidateSchema = z.object({
  schemaVersion: z.literal(1), candidateId: z.string().regex(/^m2-[a-f0-9]{64}$/), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.object({ path: z.string(), bytes: z.number().int(), sha256: z.string() }).strict()),
  stage: z.literal('foundation-only'),
}).strict();

export async function verifyCandidate(directory: string): Promise<string> {
  await verifySourceBoundaries();
  await verifyPackage(directory);
  const metadata = candidateSchema.parse(JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as unknown);
  const files = await contentManifest(directory);
  assert.deepEqual(files, metadata.files);
  assert.equal(manifestHash(files), metadata.contentSha256);
  assert.equal(metadata.candidateId, `m2-${manifestHash({ contentSha256: metadata.contentSha256, sourceFingerprint: metadata.sourceFingerprint })}`);
  assert.equal(await inputFingerprint(), metadata.sourceFingerprint, 'Candidate is stale relative to current source/tool inputs');
  return metadata.candidateId;
}

if (import.meta.main) {
  requireDevelopmentContainer();
  const pointer = z.object({ directory: z.string().regex(/^\.build\/candidates\/m2-[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readFile('.build/latest-candidate.json', 'utf8')) as unknown);
  console.log(JSON.stringify({ candidateId: await verifyCandidate(pointer.directory), static: 'passed', runtime: 'not-executed' }));
}
