import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';

const root = new URL('../../', import.meta.url);
const data = new URL('docs/baseline/', root);

test('terminal serialization dependency audit matches the pinned dependency and bundled license', async () => {
  const audit = z.object({ name: z.literal('@xterm/addon-serialize'), version: z.string(),
    integrity: z.string(), license: z.literal('MIT'), licenseAsset: z.literal('assets/third-party/xterm-addon-serialize-LICENSE.txt'),
    runtimeDependencies: z.array(z.never()).length(0), installHooks: z.array(z.never()).length(0), nativeAssets: z.array(z.never()).length(0),
  }).parse(JSON.parse(await readFile(new URL('session-terminal-dependency-audit.json', data), 'utf8')) as unknown);
  const manifest = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as unknown);
  assert.equal(manifest.dependencies[audit.name], audit.version);
  const lock = await readFile(new URL('pnpm-lock.yaml', root), 'utf8');
  assert.ok(lock.includes(`'${audit.name}@${audit.version}':\n    resolution: {integrity: ${audit.integrity}}`));
  const license = await readFile(new URL(audit.licenseAsset, root), 'utf8');
  assert.ok(license.includes('The xterm.js authors') && license.includes('Permission is hereby granted, free of charge'));
  assert.ok((await readFile(new URL('scripts/compile.ts', root), 'utf8')).includes(audit.licenseAsset));
});

for (const name of ['manifest-apply-version', 'manifest-cronjob-run', 'manifest-expose', 'manifest-scale', 'manifest-write']) {
  test(`${name} source fixture manifest matches pinned text bytes`, async () => {
    const { records } = z.object({ records: z.array(z.object({ repo: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/),
      path: z.string(), local: z.string().regex(/^tests\/fixtures\/contracts\/[\w./-]+\.txt$/),
      url: z.string().optional(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1) })
      .parse(JSON.parse(await readFile(new URL(`${name}-sources.json`, data), 'utf8')) as unknown);
    const seen = new Set<string>();
    for (const record of records) {
      assert.ok(!record.local.split('/').includes('..') && !seen.has(record.local), record.local);
      seen.add(record.local);
      if (record.url) assert.equal(record.url, `https://raw.githubusercontent.com/${record.repo}/${record.commit}/${record.path}`);
      const bytes = await readFile(new URL(record.local, root));
      assert.equal(bytes.byteLength, record.bytes, record.local);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, record.local);
    }
  });
}

test('public source records match pinned local research text', async () => {
  const index = JSON.parse(await readFile(new URL('sources.json', data), 'utf8'));
  assert.equal(index.sources[0].commit, 'f54aef89a48c64e3df66af4a75cc5dd3d80f4a75');
  assert.equal(index.sources[1].commit, '3e9ef4db17bd184f1f2713eb6356261304d6aee7');
  const names = new Set<string>();
  for (const record of index.records) {
    assert.match(record.path, /^[\w.@/-]+$/);
    assert.ok(!record.path.split('/').includes('..'));
    assert.ok(['kubernetes', 'openchamber'].includes(record.source));
    const key = `${record.source}/${record.path}`;
    assert.ok(!names.has(key));
    names.add(key);
    const bytes = await readFile(new URL(`tests/fixtures/baseline/${key}.txt`, root));
    assert.equal(bytes.byteLength, record.bytes, key);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, key);
    assert.ok(record.url.includes(index.sources.find((source: { id: string }) => source.id === record.source).commit));
  }
});

test('every declared/registered command has an exact static inventory; no runtime result is invented', async () => {
  const inventory = JSON.parse(await readFile(new URL('upstream-inventory.json', data), 'utf8'));
  const upstream = JSON.parse(await readFile(new URL('tests/fixtures/baseline/kubernetes/package.json.txt', root), 'utf8'));
  const extension = await readFile(new URL('tests/fixtures/baseline/kubernetes/src/extension.ts.txt', root), 'utf8');
  const coverage = JSON.parse(await readFile(new URL('command-coverage.json', data), 'utf8'));
  const ids = new Set<string>();
  const cases = new Set<string>();
  let menuEntries = 0;
  for (const command of inventory.commands) {
    assert.ok(!ids.has(command.command));
    assert.ok(!cases.has(command.caseId));
    ids.add(command.command);
    cases.add(command.caseId);
    assert.equal(command.registration.length, 1);
    const line = extension.split('\n')[command.registration[0].line - 1];
    assert.ok(line?.includes(command.command));
    const delivery = coverage.entries.find((item: { commandId: string | null }) => item.commandId === command.command);
    assert.equal(command.review.candidateId, delivery?.candidateId ?? null);
    assert.deepEqual(command.review.runtimeEvidence, []);
    assert.equal(command.review.implementation, delivery?.implementation ?? 'not-started');
    assert.deepEqual(command.review.implementationEvidence, delivery?.implementationEvidence);
    if (command.scope === 'included') assert.match(command.milestone, /^M[2-7]$/);
    else assert.equal(command.milestone, null);
    for (const menu of command.menus) {
      const { location, index, ...exact } = menu;
      assert.deepEqual(exact, upstream.contributes.menus[location][index]);
      menuEntries++;
    }
  }
  const registered = [...extension.matchAll(/\bregisterCommand\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual([...ids].sort(), [...new Set([...registered, ...upstream.contributes.commands.map((item: { command: string }) => item.command)])].sort());
  assert.equal(menuEntries, Object.values(upstream.contributes.menus).reduce((sum: number, values) => sum + (values as unknown[]).length, 0));
  assert.equal(ids.size, 75);
});

test('local Markdown links in documentation resolve without leaving this project', async () => {
  async function check(url: URL): Promise<void> {
    const content = await readFile(url, 'utf8');
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const href = match[1];
      if (!href || /^https?:/.test(href)) continue;
      const target = new URL(href, url);
      assert.ok(target.href.startsWith(root.href), `Link outside project: ${href}`);
      if (!target.hash || !target.pathname.endsWith('.md')) {
        assert.ok((await stat(target)).isFile(), `Not a file: ${url.pathname} → ${href}`);
        continue;
      }
      const linked = await readFile(target, 'utf8');
      const anchor = decodeURIComponent(target.hash.slice(1));
      const slug = (heading: string) => heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replaceAll(' ', '-');
      const ids = [...linked.matchAll(/^#{1,6} +(.+)$/gm)].map(value => slug(value[1] ?? ''));
      assert.ok(ids.includes(anchor) || [...linked.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].some(value => value[1] === anchor), `Missing anchor: ${url.pathname} → ${href}`);
    }
  }
  async function walk(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, directory));
      else if (entry.isFile() && entry.name.endsWith('.md')) await check(url);
    }
  }
  await check(new URL('README.md', root));
  await walk(new URL('docs/', root));
});

test('README language navigation is bidirectional and shares one clickable four-image gallery', async () => {
  const locales = ['ar', 'de', 'es', 'fr', 'he', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'];
  const docs = new URL('docs/', root);
  const i18n = new URL('i18n/', docs);
  const files = locales.map(locale => `README.${locale}.md`);
  const readmes = [new URL('README.md', root), ...files.map(file => new URL(file, i18n))];
  const screenshotDir = new URL('screenshots/', docs);
  const images = ['explorer.png', 'resource-details.png', 'terminal.png', 'port-forward.png'];
  assert.deepEqual((await readdir(i18n)).sort(), files);
  assert.ok(!(await readdir(docs)).some(file => /^README\..+\.md$/.test(file)), 'Translate the root README only under docs/i18n/');
  assert.deepEqual((await readdir(screenshotDir)).sort(), [...images].sort());

  for (const readme of readmes) {
    const markdown = await readFile(readme, 'utf8');
    const navigation = markdown.split('\n')[2] ?? '';
    const links = [...navigation.matchAll(/\]\(([^)]+)\)/g)].map(match => new URL(match[1]!, readme).href).sort();
    assert.deepEqual(links, readmes.filter(other => other !== readme).map(other => other.href).sort(), readme.pathname);
    const rows = markdown.split('\n').filter(line => line.startsWith('|') && line.includes('[!['));
    assert.equal(rows.length, 2, readme.pathname);
    for (const [index, row] of rows.entries()) {
      const cells = [...row.matchAll(/\[!\[[^\]]+\]\(([^)]+)\)\]\(([^)]+)\)/g)];
      assert.deepEqual(cells.map(cell => new URL(cell[1]!, readme).href),
        images.slice(index * 2, index * 2 + 2).map(image => new URL(image, screenshotDir).href), readme.pathname);
      assert.ok(cells.every(cell => cell[1] === cell[2]), `Thumbnail does not open the original: ${readme.pathname}`);
    }
  }
});

test('reviewed command coverage resolves exact sources, unique owners/cases and pending runtime state', async () => {
  const coverageSchema = z.object({
    schemaVersion: z.literal(2), commit: z.string(), evidence: z.literal('M1-E009'),
    entries: z.array(z.object({
      entry: z.string(), commandId: z.string().nullable(), milestone: z.enum(['M2', 'M3', 'M4', 'M5', 'M6', 'M7']), requirements: z.array(z.string()).min(1), evidence: z.string().regex(/^M1-E\d{3}$/).optional(),
      task: z.string().min(20), dependencies: z.array(z.string()).min(1), verification: z.string().min(10),
      sources: z.array(z.string()).min(1), cases: z.record(z.string(), z.string().min(10)),
      implementation: z.enum(['not-started', 'partial']), candidateId: z.string().regex(/^m2-[a-f0-9]{64}$/).nullable(), runtimeEvidence: z.array(z.never()).length(0),
      implementationEvidence: z.object({ evidence: z.string().regex(/^M[2-7]-E\d{3}$/), scope: z.string().min(20) }).strict().optional(),
    }).strict()),
    excludedEntries: z.array(z.object({ commandId: z.string(), evidence: z.string().regex(/^M1-E\d{3}$/), scope: z.enum(['excluded-internal-activation', 'excluded-clouds-view']), reason: z.string().min(20),
      sources: z.array(z.string()).min(1), cases: z.record(z.string(), z.string().min(10)) }).strict()).length(3),
  }).strict();
  const coverage = coverageSchema.parse(JSON.parse(await readFile(new URL('command-coverage.json', data), 'utf8')) as unknown);
  assert.equal(coverage.commit, 'f54aef89a48c64e3df66af4a75cc5dd3d80f4a75');
  const inventory = JSON.parse(await readFile(new URL('upstream-inventory.json', data), 'utf8'));
  const seen = new Set<string>(), cases = new Set<string>();
  for (const item of coverage.entries) {
    const semanticsEvidence = item.evidence ?? coverage.evidence;
    assert.ok(!seen.has(item.entry));
    seen.add(item.entry);
    if (item.implementation === 'not-started') {
      assert.equal(item.candidateId, null); assert.equal(item.implementationEvidence, undefined);
    } else {
      const delivery = item.implementationEvidence;
      assert.ok(delivery && delivery.evidence.startsWith(`${item.milestone}-E`));
    }
    for (const requirement of item.requirements) {
      assert.match(requirement, new RegExp(`^${item.milestone}-F[1-9]\\d*$`));
    }
    if (item.commandId !== null) {
      assert.equal(item.entry, item.commandId);
      const command = inventory.commands.find((command: { command: string }) => command.command === item.commandId);
      assert.ok(command);
      assert.equal(command.milestone, item.milestone);
      assert.equal(command.review.semantics, 'source-reviewed');
      assert.equal(command.review.semanticsEvidence, semanticsEvidence);
    } else assert.equal(item.entry, 'editor.k8s-resource.save');
    for (const source of item.sources) {
      const match = /^(src\/[\w./-]+\.(?:ts|js|html))#L(\d+)-L(\d+)$/.exec(source);
      assert.ok(match?.[1] && !match[1].split('/').includes('..'));
      const lines = (await readFile(new URL(`tests/fixtures/baseline/kubernetes/${match[1]}.txt`, root), 'utf8')).split('\n');
      assert.ok(Number(match[2]) >= 1 && Number(match[3]) <= lines.length && Number(match[2]) <= Number(match[3]));
    }
    assert.ok(Object.keys(item.cases).length >= 3);
    for (const branch of Object.keys(item.cases)) {
      const caseId = `${item.entry}#${branch}`;
      assert.ok(!cases.has(caseId));
      cases.add(caseId);
    }
  }
  for (const excluded of coverage.excludedEntries) {
    assert.ok(!seen.has(excluded.commandId)); seen.add(excluded.commandId);
    const command = inventory.commands.find((command: { command: string }) => command.command === excluded.commandId);
    assert.ok(command); assert.equal(command.scope, excluded.scope); assert.equal(command.milestone, null);
    assert.equal(command.review.semanticsEvidence, excluded.evidence); assert.equal(command.review.semantics, 'source-reviewed');
    assert.equal(command.review.candidateId, null); assert.equal(command.review.implementation, 'not-started'); assert.deepEqual(command.review.runtimeEvidence, []);
    assert.ok(Object.keys(excluded.cases).length >= 3);
    for (const source of excluded.sources) {
      const match = /^(src\/[\w./-]+\.(?:ts|js|html))#L(\d+)-L(\d+)$/.exec(source); assert.ok(match?.[1] && !match[1].split('/').includes('..'));
      const lines = (await readFile(new URL(`tests/fixtures/baseline/kubernetes/${match[1]}.txt`, root), 'utf8')).split('\n');
      assert.ok(Number(match[2]) >= 1 && Number(match[3]) <= lines.length && Number(match[2]) <= Number(match[3]));
    }
  }
  assert.equal(coverage.entries.filter(item => item.commandId !== null).length, 72);
  assert.equal(coverage.entries.length, 73);
  assert.equal(inventory.commands.filter((command: { review: { semantics: string } }) => command.review.semantics === 'source-reviewed').length, 75);
});

test('fixed Apply/Diff and cluster Watch evidence is text-only and records unsafe upstream branches, not runtime success', async () => {
  const source = (path: string) => readFile(new URL(`tests/fixtures/baseline/kubernetes/src/${path}.txt`, root), 'utf8');
  const extension = await source('extension.ts');
  const diff = extension.slice(extension.indexOf('function diffKubernetesCore('), extension.indexOf('const debugKubernetes ='));
  assert.ok(diff.includes('console.log(data, file)') && diff.includes("'vscode.diff'"));
  assert.ok(diff.includes("er.code === 1 && er.stderr.indexOf('NotFound') >= 0"));
  assert.ok(!diff.includes('kubectl diff') && !diff.includes('--dry-run') && !diff.includes('await fs.writeFile'));
  const apply = extension.slice(extension.indexOf('const applyKubernetes ='), extension.indexOf('const handleError ='));
  assert.ok(apply.includes("maybeRunKubernetesCommandForActiveWindow('create'"));
  assert.ok(apply.includes('case DiffResultKind.GetFailed:') && apply.includes('case DiffResultKind.NoKindName:'));
  const manager = await source('components/kubectl/watch.ts');
  assert.ok(manager.includes('watcher.request.abort()') && manager.includes('this.watchers.set(id, { active: false })'));
  assert.ok(manager.includes('return id && this.watchers.has(id)') && manager.includes('err as Error).name === "ECONNRESET"'));
  const explorer = await source('components/clusterexplorer/explorer.ts');
  assert.ok(explorer.includes('}, 500)') && explorer.includes('return node.kind.abbreviation') && explorer.includes('return node.kindName'));
});

test('Create/file mutations and Scale/Expose/CronJob semantics are pinned text only, including cancellation and unsafe upstream coercion', async () => {
  const source = (path: string) => readFile(new URL(`tests/fixtures/baseline/kubernetes/src/${path}.txt`, root), 'utf8');
  const extension = await source('extension.ts'), utils = await source('kubectlUtils.ts');
  const create = extension.slice(extension.indexOf('function maybeRunKubernetesCommandForActiveWindow('), extension.indexOf('function convertWindowsToWSL('));
  assert.ok(create.indexOf('getText(editor.selection)') < create.indexOf('editor.document.isUntitled'));
  assert.ok(create.includes('editor.document.isDirty') && create.includes('if (!ok)') && create.includes('kubectlTextDocument(command, editor.document'));
  const file = utils.slice(utils.indexOf('export async function createResourceFromUri('), utils.indexOf('export async function namespaceResources('));
  assert.ok(file.includes("result === 'Delete'") && file.includes("uri.scheme !== 'file'"));
  assert.ok(file.includes('vscode.workspace.asRelativePath(uri)') && file.includes('${command} -f "${path}"'));
  const scale = extension.slice(extension.indexOf('async function scaleKubernetes('), extension.indexOf('function runKubernetes('));
  assert.ok(scale.includes('parseFloat(value)') && scale.includes('Number.isInteger(replicas) && replicas >= 0'));
  assert.ok(scale.includes('scale --replicas=${replicas} ${kindName}') && !scale.includes('--namespace'));
  const kinds = await source('kuberesources.ts');
  assert.match(kinds, /scaleableKinds = \[[^]*?allKinds\.job,[^]*?allKinds\.statefulSet,/);
  const expose = extension.slice(extension.indexOf('async function exposeKubernetes('), extension.indexOf('function kubectlId('));
  assert.ok(expose.includes('ports[0]') && !expose.includes('showInputBox') && !expose.includes('--type='));
  const cron = extension.slice(extension.indexOf('async function cronJobRunNow('), extension.indexOf('async function kubernetesMergeIntoKubeconfig('));
  assert.ok(cron.includes('create job ${jobName} ${nsarg} --from=cronjob/${name}') && cron.includes('value: proposedJobName'));
  assert.ok(cron.includes('if (!jobName)') && cron.includes("get ${resourceKind.abbreviation}"));
  assert.ok((await source('utils/naming.ts')).includes('date.getFullYear()'));
});

test('config commands are pinned text-only: settings versus file writes, inactive context choice and unsafe shared-reference deletion fallthrough', async () => {
  const source = (path: string) => readFile(new URL(`tests/fixtures/baseline/kubernetes/src/${path}.txt`, root), 'utf8');
  const extension = await source('extension.ts'), utils = await source('kubectlUtils.ts'), config = await source('components/config/config.ts');
  const selection = extension.slice(extension.indexOf('async function useKubeconfigKubernetes('), extension.indexOf('async function validateKubeconfigPath('));
  assert.ok(selection.includes("typeof kubeconfig !== 'string'") && selection.includes('if (!fs.existsSync(kc))') && selection.includes('await setActiveKubeconfig(kc)'));
  const picker = extension.slice(extension.indexOf('async function getKubeconfigSelection('), extension.indexOf('async function useContextKubernetes('));
  assert.ok(picker.includes('kubeconfigUris.length === 1') && picker.includes('await addKnownKubeconfig(kubeconfigPath)'));
  assert.ok(config.includes('arrayEntry.push(value)') && config.includes('ConfigurationTarget.Global, config.globalValue, true'));
  const context = extension.slice(extension.indexOf('async function useContextKubernetes('), extension.indexOf('async function clusterInfoKubernetes('));
  assert.ok(context.includes('!context.active') && context.includes('config use-context') && context.includes('if (ExecResult.succeeded(er))') && context.includes('WatchManager.instance().clear()'));
  const deletion = utils.slice(utils.indexOf('export async function deleteCluster('), utils.indexOf('export async function getAsDataResource('));
  assert.ok(deletion.indexOf('config delete-cluster') < deletion.indexOf('config unset users.') && deletion.indexOf('config unset users.') < deletion.indexOf('config delete-context'));
  assert.equal(deletion.match(/return false/g)?.length, 2); // missing CLI at first step or final step failure, not all early failures.
  assert.ok(deletion.includes("resultKind === 'exec-bin-not-found'") && !deletion.includes('getContexts') && !deletion.includes('.filter('));
});
