// Static isolation audit: allowlists, import graphs of every test file, hook/CI gates and compose gating facts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseAst } from 'rolldown/parseAst';
import { filesBelow } from '../../scripts/build-input.ts';
import { staticTestFiles } from '../../scripts/static-tests.ts';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function importSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const program = parseAst(code, { lang: 'ts', astType: 'ts' }, 'tests.ts');
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.type === 'string' && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      const source = (node.source as Record<string, unknown> | undefined)?.value;
      if (typeof source === 'string') specifiers.push(source);
    }
    for (const [key, child] of Object.entries(node)) if (!['loc', 'range', 'start', 'end'].includes(key)) visit(child);
  };
  visit(program);
  return specifiers;
}

const forbiddenBuiltin = /^node:(child_process|net|http|https|dgram|worker_threads|tls|udp)$/;
const writeModule = /^src\/service\/(operations|sessions|runtime)\//;
const writeAdapter = /^src\/service\/adapters\//;
const writeClient = /^src\/host\/(delete-client|namespace-client|namespace-delete-client|context-client|context-delete-client|preference-client|preference-transport|file-save-client|manifest-create-client|manifest-apply-client|scale-client|cronjob-run-client|expose-client|config-file-delete-client|config-file-add-client|file-delete-client|helm-refresh-client|helm-inspect-client|helm-values-client|helm-dependencies-client|helm-lint-client|helm-template-client|helm-dryrun-client|helm-package-client|helm-depup-client|helm-create-client|helm-fetch-client|helm-requirement-client|helm-convert-client|helm-parameterise-client)\.ts$/;

test('the static allowlist matches the actual static suite files exactly', async () => {
  const actual = (await filesBelow(new URL('../../tests/static', import.meta.url).pathname)).map(path => path.slice(process.cwd().length + 1)).sort();
  assert.deepEqual(actual, [...staticTestFiles].sort());
});

test('no test file imports process/network builtins or reaches write executors, write adapters or write clients', async () => {
  const roots = ['tests/readonly', 'tests/static'];
  for (const root of roots) {
    for (const path of await filesBelow(new URL(`../../${root}`, import.meta.url).pathname)) {
      const relative = path.slice(process.cwd().length + 1);
      const code = await readFile(path, 'utf8');
      for (const specifier of importSpecifiers(code)) {
        assert.ok(!forbiddenBuiltin.test(specifier), `${relative} imports a forbidden builtin: ${specifier}`);
        if (!specifier.startsWith('../../src/') && !specifier.startsWith('../src/')) continue;
        const resolved = specifier.replaceAll('../', '');
        assert.ok(!writeModule.test(resolved) && !writeAdapter.test(resolved) && !writeClient.test(resolved), `${relative} reaches a write path: ${specifier}`);
        assert.ok(resolved !== 'src/panel/entry.ts', `${relative} imports the executable panel entry`);
        if (relative.startsWith('tests/static/')) assert.ok(resolved.startsWith('src/service/queries/') || resolved.startsWith('src/shared/') || resolved.startsWith('src/parsing/'), `${relative} imports product code beyond read-only roots: ${specifier}`);
      }
    }
  }
});

test('package hooks and CI gates stay closed: no lifecycle scripts, no pre/post hooks, no CI config among engineering inputs', async () => {
  const workspace = await file('pnpm-workspace.yaml');
  assert.ok(workspace.includes('ignoreScripts: true'));
  assert.ok(workspace.includes('enablePrePostScripts: false'));
  assert.ok(workspace.includes('pmOnFail: error') && workspace.includes('runtimeOnFail: error') && workspace.includes('verifyDepsBeforeRun: error'));
  const root = JSON.parse(await file('package.json')) as { scripts: Record<string, string> };
  for (const name of Object.keys(root.scripts)) assert.ok(!/^pre|^post/.test(name), `unexpected lifecycle script: ${name}`);
  const develop = await file('scripts/develop.ts');
  assert.ok(develop.includes('in-container.ts') && develop.includes('--pull') && develop.includes('never'));
});

test('compose keeps no service/bootstrap/healthcheck lifecycle and no privilege escalation path', async () => {
  const compose = await file('docker-compose.yml');
  assert.ok(!compose.includes('healthcheck'));
  assert.ok(!/entrypoint/i.test(compose));
  assert.ok(compose.includes('cap_drop: [ALL]') && compose.includes('no-new-privileges:true') && compose.includes("restart: 'no'"));
  assert.ok(!compose.includes('privileged') && !compose.includes('host network') && !/\/var\/run\/docker\.sock/.test(compose));
  const dockerfile = await file('docker/dev.Dockerfile');
  assert.ok(dockerfile.includes('ENTRYPOINT []'));
  assert.ok(!/^\s*HEALTHCHECK/m.test(dockerfile), 'Dockerfile must not define a HEALTHCHECK instruction');
});
