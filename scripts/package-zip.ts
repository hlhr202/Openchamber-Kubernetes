// Deterministic prebuilt-ZIP packaging for the current install candidate.
// Reads the verified candidate directory, emits a byte-reproducible ZIP into the controlled
// .build artifact area, verifies it by parsing it back, and refuses to publish partial output.
// No host installation, registry publish, or product code path is touched.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { contentManifest, inputFingerprint, manifestHash } from './build-input.ts';
import { verifyCandidate } from './check-static.ts';
import { requireDevelopmentContainer } from './development.ts';

export type ZipEntry = { readonly path: string; readonly bytes: Buffer };

// Fixed ZIP metadata for reproducibility: MS-DOS 1980-01-01 00:00, deflate, no extra fields,
// no comments, deterministic external attributes; entry order is the sorted candidate manifest.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;

function dosDateTime(): { time: number; date: number } { return { time: FIXED_DOS_TIME, date: FIXED_DOS_DATE }; }

export function buildZipBytes(entries: readonly ZipEntry[]): Buffer {
  const ordered = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of ordered) {
    const name = Buffer.from(entry.path, 'utf8');
    if (entry.path.includes('\\') || name.length > 0xffff) throw new Error(`Unrepresentable ZIP entry path: ${entry.path}`);
    const checksum = crc32(entry.bytes);
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const method = deflated.length < entry.bytes.length ? 8 : 0;
    const payload = method === 8 ? deflated : entry.bytes;
    const { time, date } = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6); // no flags: sizes/CRC are written directly, no data descriptor.
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // no extra field
    central.writeUInt16LE(0, 32); // no comment
    central.writeUInt16LE(0, 34); // first disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // fixed external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment
  return Buffer.concat([...locals, centralDirectory, end]);
}

export type ParsedZipEntry = { readonly path: string; readonly method: number; readonly time: number; readonly date: number; readonly crc32: number; readonly bytes: Buffer };

export function parseZipArchive(archive: Buffer): readonly ParsedZipEntry[] {
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(0x06054b50, 0);
  const endOffset = archive.lastIndexOf(signature);
  if (endOffset < 0 || endOffset + 22 > archive.length) throw new Error('ZIP end-of-central-directory record not found');
  if (archive.readUInt16LE(endOffset + 20) !== 0) throw new Error('ZIP comment is not allowed in controlled archives');
  const count = archive.readUInt16LE(endOffset + 10);
  const directorySize = archive.readUInt32LE(endOffset + 12);
  const directoryOffset = archive.readUInt32LE(endOffset + 16);
  if (directoryOffset + directorySize !== endOffset) throw new Error('ZIP central directory is not contiguous with the end record');
  const entries: ParsedZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central directory signature mismatch');
    const method = archive.readUInt16LE(cursor + 10);
    const time = archive.readUInt16LE(cursor + 12);
    const date = archive.readUInt16LE(cursor + 14);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (extraLength !== 0 || commentLength !== 0) throw new Error(`ZIP entry carries extra metadata: ${path}`);
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header mismatch: ${path}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    if (localNameLength !== nameLength || localExtraLength !== 0) throw new Error(`ZIP local/central name mismatch: ${path}`);
    const payload = archive.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + compressedSize);
    if (payload.length !== compressedSize || compressedSize === 0 || uncompressedSize === 0) throw new Error(`ZIP payload size mismatch: ${path}`);
    const bytes = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (bytes.length !== uncompressedSize || (crc32(bytes) >>> 0) !== checksum) throw new Error(`ZIP payload integrity mismatch: ${path}`);
    entries.push({ path, method, time, date, crc32: checksum, bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== endOffset) throw new Error('ZIP central directory has trailing bytes');
  return entries;
}

const metadataSchema = z.object({
  schemaVersion: z.literal(1), candidateId: z.string().regex(/^m2-[a-f0-9]{64}$/), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  zipSha256: z.string().regex(/^[a-f0-9]{64}$/), zipBytes: z.number().int().positive(),
  entries: z.array(z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), crc32: z.number().int().nonnegative(), method: z.number().int() }).strict()),
  digestScope: z.string(), format: z.string(), producedBy: z.literal('scripts/package-zip.ts'), reproducibleCheck: z.string(), runtimeNode: z.string(),
}).strict();

if (import.meta.main) {
  requireDevelopmentContainer();
  const source = await inputFingerprint();
  const pointer = z.object({ directory: z.string().regex(/^\.build\/candidates\/m2-[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readFile('.build/latest-candidate.json', 'utf8')) as unknown);
  const candidateId = await verifyCandidate(pointer.directory); // Rejects a stale candidate relative to current inputs.
  const manifest = await contentManifest(pointer.directory);
  const entries: ZipEntry[] = [];
  for (const file of manifest) entries.push({ path: file.path, bytes: await readFile(resolve(pointer.directory, file.path)) });
  const archive = buildZipBytes(entries);
  const again = buildZipBytes(entries.reverse()); // Order-independence of the builder proves fixed entry ordering.
  if (!archive.equals(again)) throw new Error('ZIP build is not byte-reproducible for identical inputs');
  const parsed = parseZipArchive(archive);
  if (parsed.length !== manifest.length) throw new Error('ZIP entry count mismatch');
  for (const entry of parsed) {
    const expected = manifest.find(file => file.path === entry.path);
    if (!expected || !entry.bytes.equals(await readFile(resolve(pointer.directory, entry.path)))) throw new Error(`ZIP unpack mismatch: ${entry.path}`);
    if (entry.method !== 0 && entry.method !== 8 || entry.time !== FIXED_DOS_TIME || entry.date !== FIXED_DOS_DATE) throw new Error(`ZIP fixed metadata drifted: ${entry.path}`);
  }
  const digestScope = 'zipSha256 covers the full ZIP bytes; entries cover exactly the candidate package files, self-referential candidate.json excluded (same rule as contentSha256)';
  const metadata = metadataSchema.parse({
    schemaVersion: 1, candidateId, sourceFingerprint: source, contentSha256: manifestHash(manifest), zipSha256: createHash('sha256').update(archive).digest('hex'), zipBytes: archive.length,
    entries: parsed.map(entry => ({ path: entry.path, bytes: entry.bytes.length, sha256: createHash('sha256').update(entry.bytes).digest('hex'), crc32: entry.crc32, method: entry.method })),
    digestScope, format: 'zip-store-deflate-fixed-dos-1980-01-01-no-extras-no-comments-sorted-paths', producedBy: 'scripts/package-zip.ts',
    reproducibleCheck: 'second in-memory build from reversed inputs is byte-identical; archive parsed back and every entry compared to the candidate files', runtimeNode: process.versions.node,
  });
  if (await inputFingerprint() !== source) throw new Error('Inputs changed during packaging; nothing published');
  await mkdir('.build/packages', { recursive: true });
  const staging = resolve('.build/staging', randomUUID());
  await mkdir(resolve(staging, 'package'), { recursive: true });
  await writeFile(resolve(staging, 'package', 'package.zip'), archive);
  await writeFile(resolve(staging, 'package', 'package-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const directory = `.build/packages/${candidateId}`;
  try { await rename(resolve(staging, 'package'), directory); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['EEXIST', 'ENOTEMPTY'].includes(String(error.code))) throw error;
    const previous = metadataSchema.parse(JSON.parse(await readFile(resolve(directory, 'package-metadata.json'), 'utf8')) as unknown);
    if (previous.zipSha256 !== metadata.zipSha256) throw new Error('Package identity collision; existing package preserved');
  } finally { await rm(staging, { recursive: true, force: true }); }
  const report = `.build/reports/package-${randomUUID()}.json`;
  await writeFile(report, `${JSON.stringify({ directory, metadata: `${directory}/package-metadata.json`, zip: `${directory}/package.zip`, sourceFingerprint: source, candidateId }, null, 2)}\n`);
  await rename(report, '.build/reports/latest-package.json');
  console.log(JSON.stringify({ directory, candidateId, zipBytes: metadata.zipBytes, zipSha256: metadata.zipSha256, entries: parsed.length, runtime: 'not-installed' }));
}
