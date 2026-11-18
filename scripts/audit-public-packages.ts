// Downloads archives into memory for static review; never extracts or runs a tool on the host.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const destination = new URL('../.build/package-audit/', import.meta.url);
const packages = [
  ['pnpm', '12.15.0'], ['typescript', '7.0.2'], ['rolldown', '1.2.15'], ['oxlint', '1.89.0'],
  ['@openchamber/sdk', '2.5.1'], ['yaml', '2.8.3'], ['@types/node', '24.9.0'],
] as const;
const summary: unknown[] = [];
await mkdir(destination, { recursive: true });
for (const [name, version] of packages) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name}: metadata HTTP ${response.status}`);
  const metadata: unknown = await response.json();
  if (typeof metadata !== 'object' || metadata === null || !('dist' in metadata)) throw new Error('Invalid package metadata');
  const dist = metadata.dist;
  if (typeof dist !== 'object' || dist === null || !('tarball' in dist) || typeof dist.tarball !== 'string'
    || !('integrity' in dist) || typeof dist.integrity !== 'string' || !dist.tarball.startsWith('https://registry.npmjs.org/')) throw new Error('Invalid archive origin');
  const archive = await fetch(dist.tarball, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!archive.ok) throw new Error('Archive unavailable');
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (bytes.byteLength > 16_000_000) throw new Error('Archive budget exceeded');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== dist.integrity) throw new Error('Archive integrity mismatch');
  const tar = gunzipSync(bytes, { maxOutputLength: 32_000_000 });
  const id = name.replaceAll('/', '__').replace('@', '');
  const path = new URL(`${id}/`, destination);
  await mkdir(path, { recursive: true });
  const files: Array<{ name: string; bytes: number; sha256: string; saved: boolean }> = [];
  let manifest: unknown;
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const file = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.byteLength) throw new Error('Malformed static review archive');
    const type = header.toString('ascii', 156, 157);
    const content = tar.subarray(offset + 512, offset + 512 + size);
    const saved = (type === '0' || type === '\0') && /^(package|node)\/(package\.json|install\.js|native-binary\.mjs|bin\/tsc|bin\/pnpm\.mjs|lib\/(tsc|getExePath)\.js|dist\/index\.d\.mts|pnpm|src\/index\.ts|API\.md|GUEST_SERVICES\.md|LICENSE|README\.md)$/.test(file);
    if (saved) {
      await writeFile(new URL(`${file.replaceAll('/', '__')}.txt`, path), content);
      if (file.endsWith('/package.json')) manifest = JSON.parse(content.toString('utf8'));
    }
    files.push({ name: file, bytes: size, sha256: createHash('sha256').update(content).digest('hex'), saved });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!manifest) throw new Error(`No reviewed manifest: ${name}`);
  await writeFile(new URL('files.json', path), `${JSON.stringify(files, null, 2)}\n`);
  summary.push({ name, version, integrity, archiveBytes: bytes.byteLength, unpackedBytes: tar.byteLength, manifest, files: files.length });
}
await writeFile(new URL('summary.json', destination), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.map(item => {
  if (typeof item !== 'object' || item === null) throw new Error('Invalid summary');
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'manifest'));
}), null, 2));
