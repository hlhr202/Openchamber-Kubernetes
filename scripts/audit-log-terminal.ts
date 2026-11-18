// Static public archive review only. Saves selected text, never installs/extracts executable tools on the host.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const root = new URL('../tests/fixtures/contracts/log-terminal-review/', import.meta.url);
const response = await fetch('https://registry.npmjs.org/@xterm/xterm/6.0.0', { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!response.ok) throw new Error('Public terminal metadata unavailable');
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const metadata = record(await response.json());
if (!metadata || metadata.name !== '@xterm/xterm' || metadata.version !== '6.0.0' || metadata.license !== 'MIT' || typeof metadata.gitHead !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.gitHead)) throw new Error('Terminal dependency identity changed');
const dependencies = metadata.dependencies === undefined ? {} : record(metadata.dependencies), scripts = record(metadata.scripts), dist = record(metadata.dist);
if (!dependencies || Object.keys(dependencies).length || !scripts || ['preinstall', 'install', 'postinstall', 'prepare'].some(key => scripts[key] !== undefined)
  || !dist || typeof dist.integrity !== 'string' || dist.tarball !== 'https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz') throw new Error('Terminal dependency contract changed');
const archive = await fetch('https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz', { signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!archive.ok) throw new Error('Terminal archive unavailable'); const bytes = Buffer.from(await archive.arrayBuffer());
if (bytes.length > 8_000_000 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== dist.integrity) throw new Error('Terminal archive budget/integrity');
const tar = gunzipSync(bytes, { maxOutputLength: 16_000_000 }); await mkdir(root, { recursive: true }); const files = [];
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512); if (header.every(value => value === 0)) break;
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/, ''), size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid review archive');
  const content = tar.subarray(offset + 512, offset + 512 + size), saved = ['package/package.json', 'package/LICENSE', 'package/css/xterm.css', 'package/typings/xterm.d.ts', 'package/README.md'].includes(name);
  if (saved) await writeFile(new URL(`${name.replaceAll('/', '__')}.txt`, root), content, { flag: 'wx' });
  files.push({ name, bytes: size, sha256: createHash('sha256').update(content).digest('hex'), saved }); offset += 512 + Math.ceil(size / 512) * 512;
}
const report = { name: metadata.name, version: metadata.version, license: metadata.license, commit: metadata.gitHead, integrity: dist.integrity, archiveBytes: bytes.length, unpackedTarBytes: tar.length, files, runtimeDependencies: [], installHooks: [], execution: 'not-executed-static-text-only' };
await writeFile(new URL('report.json', root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ archiveBytes: bytes.length, unpackedTarBytes: tar.length, files: files.length, saved: files.filter(file => file.saved).length, integrity: report.integrity }));
