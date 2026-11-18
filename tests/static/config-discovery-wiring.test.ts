// Text-only source review; never imports/calls runtime, bridge, configuration writer or source hooks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let previous = -1; for (const part of parts) { const next = text.indexOf(part, previous + 1); assert.ok(next > previous, part); previous = next; } };

test('service captures only actual received KUBECONFIG once and shares exact frozen default paths with reader and unique configuration writer', async () => {
  const main = await file('src/service/runtime/main.ts');
  ordered(main, 'discoverDefaultConfig(environment).paths', 'createConfigReader(defaultPaths, undefined, credentials.resolve, credentials.reject)', 'createNamespaceFileAdapter(defaultPaths)');
  assert.ok(main.includes('const kubeconfig = process.env.KUBECONFIG') && main.includes('cwd: process.cwd()') && main.includes('...(kubeconfig === undefined ? {} : { kubeconfig })'));
  assert.ok(!/execSync|spawnSync|\/proc\/|Object\.entries\(process\.env\)|\.\.\.process\.env/.test(main));
});
test('discovery is pure string-only POSIX precedence and never reads ambient HOME/env/files or runs migration/authentication', async () => {
  const code = await file('src/service/queries/config-discovery.ts');
  assert.ok(code.includes("value.split(':').filter(path => path !== '')") && code.includes('posix.resolve(input.cwd, path)') && code.includes("value === undefined || value === ''"));
  assert.ok(code.includes('parts.length > 64') && code.includes('24_000') && code.includes('Object.freeze'));
  assert.ok(!/from ['"]node:(?:fs|child_process)|process\.env\.|process\.cwd\(|readFile\(|realpath\(|\.Migrate\(/.test(code));
});
test('all multi-source configuration write preparations resolve the same default precedence; legacy single-source helpers reject ambiguity', async () => {
  const code = await file('src/service/adapters/namespace-file.ts');
  assert.equal(code.split("selection.mode === 'default' ? defaultPaths").length - 1, 3);
  assert.equal(code.split('resolveConfigSelection(selection, defaultPaths).orderedPaths').length - 1, 3);
  ordered(code.slice(code.indexOf('function pathFor(')), 'defaultPaths[0]', 'defaultPaths.length !== 1', 'return path');
  assert.ok(code.includes('const defaultPaths = defaultConfigPaths(defaults)') && code.includes('const destination = values[0]') && code.includes('value.path === context.sourcePath'));
});
test('reader binds frozen defaults into selection and config identity without a global mutable active source or fallback after missing', async () => {
  const code = await file('src/service/queries/config-source.ts');
  assert.ok(code.includes('const defaultPaths = defaultConfigPaths(defaults)'));
  assert.equal(code.split('resolveConfigSelection(selection, defaultPaths)').length - 1, 5);
  ordered(code.slice(code.indexOf('async transportRead(')), 'readSelection(resolveConfigSelection(selection, defaultPaths)', 'result.publicRead.snapshot.configIdentity !== expectedIdentity', 'await transportCredentials(result.merged, expectedIdentity, signal, target)');
  ordered(code, 'for (const path of selection.orderedPaths)', 'const input = await readFile(path, signal)', 'missing.push(path)', 'source-selection', 'JSON.stringify({ ...selection, missing })');
});
test('fixed client-go default loader evidence distinguishes absent environment from empty filenames and retains first-file merge semantics', async () => {
  const go = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/loader.go.txt');
  ordered(go, 'envVarFiles := os.Getenv(RecommendedConfigPathEnvVar)', 'if len(envVarFiles) != 0', 'filepath.SplitList(envVarFiles)', 'deduplicate(fileList)', 'chain = append(chain, RecommendedHomeFile)');
  ordered(go.slice(go.indexOf('for _, filename := range kubeConfigFiles')), 'if len(filename) == 0', 'continue', 'LoadFromFile(filename)');
});
test('UI explicitly discloses official environment omission and manual source fallback rather than claiming full Server shell discovery', async () => {
  const panel = await file('src/panel/main.ts'), tests = await file('tests/readonly/config-discovery.test.ts');
  assert.ok(panel.includes('Specify a file if the default is missing') && panel.includes('may run a credential plugin'));
  assert.ok(!/from ['"].*(?:runtime\/|adapters\/|operations\/|bridge|preference-client|namespace-client)/.test(tests));
});
test('all four write clients accept service-attested default source counts while explicit file and merge checks remain strict', async () => {
  for (const name of ['context-client', 'namespace-client', 'context-delete-client', 'namespace-delete-client']) {
    const code = await file(`src/host/${name}.ts`);
    assert.ok(!code.includes("selection.mode !== 'merge'"), name);
    assert.match(code, /selection\.mode === 'file' && (?:paths|sources)\.length !== 1/, name);
    assert.ok(code.includes("selection.mode === 'merge' && JSON.stringify(paths)") && code.includes('selection.paths'), name);
    assert.ok(code.includes('sameConfiguration') || code.includes('sameTarget'), name);
    assert.ok(code.includes('this.#release(response.grant)'), name);
  }
});
