// Format/wiring only: deterministic ZIP construction and packaging task registration; no artifacts installed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildZipBytes, parseZipArchive } from '../../scripts/package-zip.ts';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const entries = [
  { path: 'panel/main.js', bytes: Buffer.from('console.log("panel body repeated repeated repeated");') },
  { path: 'LICENSE', bytes: Buffer.from('MIT License text') },
  { path: 'service/main.js', bytes: Buffer.from('export const service = 1;') },
];

test('zip construction is byte-reproducible with fixed metadata and sorted entry order', () => {
  const archive = buildZipBytes(entries);
  assert.ok(archive.equals(buildZipBytes([...entries])), 'identical inputs must be byte-identical');
  assert.ok(archive.equals(buildZipBytes([...entries].reverse())), 'entry input order must not affect bytes');
  const rebuilt = buildZipBytes([{ path: 'LICENSE', bytes: entries[1]!.bytes }, { path: 'panel/main.js', bytes: entries[0]!.bytes }, { path: 'service/main.js', bytes: entries[2]!.bytes }]);
  assert.ok(archive.equals(rebuilt), 'pre-sorted inputs produce the same archive');
  const parsed = parseZipArchive(archive);
  assert.deepEqual(parsed.map(entry => entry.path), ['LICENSE', 'panel/main.js', 'service/main.js']);
  for (const entry of parsed) {
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 0x0021);
    assert.ok(entry.method === 8 || entry.method === 0);
  }
});

test('zip parsing verifies integrity and rejects malformed controlled archives', () => {
  const archive = buildZipBytes(entries);
  const parsed = parseZipArchive(archive);
  assert.deepEqual(parsed.map(entry => entry.bytes.toString()), [entries[1]!.bytes.toString(), entries[0]!.bytes.toString(), entries[2]!.bytes.toString()]);
  const flipped = Buffer.from(archive);
  const original = flipped[40];
  assert.ok(original !== undefined);
  flipped[40] = original ^ 0xff;
  assert.throws(() => parseZipArchive(flipped));
  assert.throws(() => parseZipArchive(archive.subarray(0, archive.length - 1)), /end-of-central-directory|trailing|not found/);
  const commented = Buffer.from(archive);
  commented.writeUInt16LE(1, commented.length - 2);
  assert.throws(() => parseZipArchive(commented), /comment/);
  assert.throws(() => buildZipBytes([{ path: 'a\\b', bytes: Buffer.from('x') }]), /Unrepresentable/);
});

test('packaging is a registered bounded task that verifies candidate identity and refuses changed inputs', async () => {
  const develop = await file('scripts/develop.ts');
  const container = await file('scripts/in-container.ts');
  assert.ok(develop.includes("'package:zip'"));
  assert.ok(container.includes("'package:zip': ['node', 'scripts/package-zip.ts']"));
  const script = await file('scripts/package-zip.ts');
  assert.ok(script.includes('await verifyCandidate(pointer.directory)'));
  assert.ok(script.includes("throw new Error('Inputs changed during packaging; nothing published')"));
});
