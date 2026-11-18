// Build artifacts only. The fixture imports presentation views (not mountPanel or
// the host bridge), supplies NO bridge, and never invokes authentication/writes.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'rolldown';
import { requireDevelopmentContainer } from './development.ts';
requireDevelopmentContainer();
const directory = '.build/reports/panel-audit';
await mkdir(directory, { recursive: true });
const names = (await readdir('src/panel')).filter(name => name.endsWith('view.ts')).sort();
const entries: string[] = [];
const imports: string[] = [];
for (const [index, name] of names.entries()) {
  const source = await readFile(`src/panel/${name}`, 'utf8');
  const functions = [...source.matchAll(/export function (mount\w+)/g)].map(match => match[1]!);
  imports.push(`import * as view${index} from ${JSON.stringify(resolve('src/panel', name))};`);
  for (const fn of functions) entries.push(`${JSON.stringify(`${name}:${fn}`)}: view${index}.${fn}`);
}
await writeFile(`${directory}/entry.ts`, `${imports.join('\n')}\nimport { runPanelAudit } from ${JSON.stringify(resolve('tests/fixtures/visual/panel-audit.ts'))};\nrunPanelAudit({${entries.join(',\n')}});\n`);
await build({ input: resolve(directory, 'entry.ts'), platform: 'browser', output: { file: resolve(directory, 'audit.js'), format: 'iife' } });
await writeFile(`${directory}/main.css`, await readFile('assets/panel/main.css'));
await writeFile(`${directory}/index.html`, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Panel audit — synthetic only</title><link rel="stylesheet" href="main.css"><style>
html,body{overflow:auto} #app{height:auto;min-height:800px} .audit-nav{display:flex;gap:.5rem;flex-wrap:wrap;padding:.5rem;color:var(--oc-fg);background:var(--oc-bg);font: .8rem var(--oc-font)} #report{white-space:pre-wrap;overflow-wrap:anywhere;font: .75rem var(--oc-mono)}
.oc-k8s-subview-shell{min-height:700px} .audit-nav select{max-width:100%}
</style></head><body><div class="audit-nav"><span>合成 UI · 无宿主/集群连接</span><button id="theme">切换主题</button><button id="locale">切换语言</button><button id="repeat">重复宿主快照</button></div><pre id="report" role="status"></pre><div id="app"><div class="oc-k8s-subview-shell" id="audit"></div></div><script src="audit.js"></script></body></html>`);
await writeFile(`${directory}/narrow.html`, '<!doctype html><html><head><meta charset="utf-8"><title>360px panel audit</title></head><body style="margin:0"><iframe title="360px synthetic panel audit" src="index.html" style="width:360px;height:1100px;border:0"></iframe></body></html>');
await writeFile(`${directory}/wide.html`, '<!doctype html><html><head><meta charset="utf-8"><title>1440px panel audit</title></head><body style="margin:0"><iframe title="1440px synthetic panel audit" src="index.html" style="width:1440px;height:1000px;border:0"></iframe></body></html>');
console.log(JSON.stringify({ directory, modules: names.length, mounts: entries.length, hostBridge: false, clusterRequests: 0 }));
