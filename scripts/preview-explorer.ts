// Builds a standalone PURE DISPLAY page. No host bridge, credentials, cluster,
// operations or sessions. It is never part of the installable plugin.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'rolldown';
import { requireDevelopmentContainer } from './development.ts';

requireDevelopmentContainer();
const directory = '.build/reports/rx-theme-preview';
await mkdir(directory, { recursive: true });
await build({ input: 'tests/fixtures/visual/explorer-theme.ts', platform: 'browser',
  output: { file: `${directory}/preview.js`, format: 'iife' } });
await writeFile(`${directory}/main.css`, await readFile('assets/panel/main.css'));
await writeFile(`${directory}/index.html`, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kubernetes · Theme fixture</title><link rel="stylesheet" href="main.css">
<style>
body { background: var(--oc-bg); color: var(--oc-fg); }
.fixture-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; padding: .4rem .5rem; font: .75rem var(--oc-font); }
.fixture-toolbar button { border: 1px solid var(--oc-border); background: var(--oc-bg); color: var(--oc-fg); padding: .2rem .5rem; border-radius: 4px; }
#app { height: calc(100dvh - 2.5rem); }
#fixture-checks { margin-inline-start: auto; }
@media (max-width:899px) { #app .oc-k8s-subview-shell { display:none; } #fixture-checks { display:none; } }
</style></head><body>
<div class="fixture-toolbar"><span>展示用合成数据 · 不连接集群</span><button id="dark">深色</button><button id="light">浅色</button><span id="fixture-checks" role="status"></span></div>
<div id="app"></div><script src="preview.js"></script></body></html>`);
// A real 1440px child viewport also exercises media queries when the browser panel
// itself is narrow. Both documents contain synthetic presentation data only.
await writeFile(`${directory}/wide.html`, '<!doctype html><html><head><meta charset="utf-8"><title>Kubernetes · Wide theme fixture</title></head><body style="margin:0"><iframe title="1440px synthetic explorer" src="index.html" style="width:1440px;height:900px;border:0;display:block"></iframe></body></html>');
console.log(JSON.stringify({ directory, scope: 'synthetic-pure-display-only', clusterRequests: 0 }));
