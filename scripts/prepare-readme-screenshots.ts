import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { requireDevelopmentContainer } from './development.ts';

requireDevelopmentContainer();
const source = 'tests/fixtures/readme-screenshots', directory = '.build/reports/readme-screenshots';
await mkdir(directory, { recursive: true });
await build({ input: `${source}/entry.ts`, platform: 'browser', transform: { target: 'es2022' },
  output: { file: `${directory}/preview.js`, format: 'iife', codeSplitting: false } });
const xtermCss = resolve(dirname(fileURLToPath(import.meta.resolve('@xterm/xterm'))), '../css/xterm.css');
await Promise.all([
  copyFile(`${source}/index.html`, `${directory}/index.html`),
  copyFile(`${source}/frame.css`, `${directory}/frame.css`),
  copyFile('assets/panel/main.css', `${directory}/panel.css`),
  copyFile('assets/panel/icon.svg', `${directory}/icon.svg`),
  copyFile(xtermCss, `${directory}/xterm.css`),
]);
console.log(JSON.stringify({ directory, scope: 'synthetic display state, no operation chains' }));
