// Builds ONLY a pure presentation fixture. The browser runs in a separate,
// network-isolated container; never run this page in the host browser.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'rolldown';
import { requireDevelopmentContainer } from './development.ts';
requireDevelopmentContainer();
const directory = '.build/reports/ui-refresh-browser';
await mkdir(directory, { recursive: true });
await build({ input: 'tests/fixtures/ui-refresh/entry.ts', platform: 'browser', transform: { target: 'es2022' },
  output: { file: `${directory}/check.js`, format: 'iife', codeSplitting: false, minify: false } });
await copyFile('assets/panel/main.css', `${directory}/panel.css`);
await writeFile(`${directory}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><title>Pure UI refresh regression</title></head><body><script src="./check.js"></script></body></html>');
console.log(JSON.stringify({ directory, scope: 'pure presentation only', operatingChainsExecuted: false }));
