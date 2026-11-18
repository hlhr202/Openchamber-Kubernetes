import { z } from 'zod';
import { boundedName, containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
export const helmRepositoryName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const path = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !containsControlCharacters(value) && hasWellFormedUnicode(value));
export const helmRepositoryPathsSchema = z.object({ repositoryFile: path, indexDirectory: path }).strict();
export const helmRepositorySelectionSchema = z.union([z.object({ mode: z.literal('default') }).strict(), helmRepositoryPathsSchema]);
export type HelmRepositorySelection = z.infer<typeof helmRepositorySelectionSchema>;
export const helmRepositoryOriginsSchema = z.object({
  repositoryFile: z.enum(['explicit', 'HELM_REPOSITORY_CONFIG', 'HELM_CONFIG_HOME', 'XDG_CONFIG_HOME', 'platform-default']),
  indexDirectory: z.enum(['explicit', 'HELM_REPOSITORY_CACHE', 'HELM_CACHE_HOME', 'XDG_CACHE_HOME', 'platform-default']),
}).strict();
export type HelmRepositorySource = { readonly paths: z.infer<typeof helmRepositoryPathsSchema>; readonly origins: z.infer<typeof helmRepositoryOriginsSchema> };
export const helmRepositoryBindingSchema = z.object({ serviceGeneration: boundedName, projectId: boundedName, selection: helmRepositorySelectionSchema }).strict();
const snapshot = z.string().regex(/^helm-[a-f0-9]{64}$/);
const branch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repositories') }).strict(),
  z.object({ kind: z.literal('charts'), repository: helmRepositoryName, configurationId: snapshot }).strict(),
  z.object({ kind: z.literal('versions'), repository: helmRepositoryName, chart: helmRepositoryName, configurationId: snapshot, indexId: snapshot }).strict(),
]);
export const helmRepositoryRequestSchema = z.object({ protocol: z.literal(2), binding: helmRepositoryBindingSchema, branch,
  offset: z.number().int().min(0).max(20_000).default(0), snapshotId: snapshot.optional() }).strict().refine(value => value.offset === 0 || value.snapshotId !== undefined);
export type HelmRepositoryRequest = z.infer<typeof helmRepositoryRequestSchema>;
const text = (limit: number) => z.string().max(limit).refine(hasWellFormedUnicode);
export const helmRepositoryNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository'), id: boundedName, label: helmRepositoryName, repository: helmRepositoryName }).strict(),
  z.object({ kind: z.literal('chart'), id: boundedName, label: helmRepositoryName, repository: helmRepositoryName, chart: helmRepositoryName }).strict(),
  z.object({ kind: z.literal('version'), id: boundedName, label: text(256), repository: helmRepositoryName, chart: helmRepositoryName, version: text(256), appVersion: text(1024), description: text(8192), tooltip: text(10_000) }).strict(),
]);
export type HelmRepositoryNode = z.infer<typeof helmRepositoryNodeSchema>;
export const helmRepositoryPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('helm-repositories'), binding: helmRepositoryBindingSchema, branch,
  resolvedSelection: helmRepositoryPathsSchema, sourceOrigins: helmRepositoryOriginsSchema,
  configurationId: snapshot, indexId: snapshot.nullable(), snapshotId: snapshot, offset: z.number().int().min(0).max(20_000),
  total: z.number().int().min(0).max(20_000), nextOffset: z.number().int().min(1).max(20_000).nullable(), nodes: z.array(helmRepositoryNodeSchema).max(100),
  versionPolicy: z.literal('helm-v3.19.0-semver-v3.4.0-stable-gt-zero'), provenance: z.literal('filename-only-unverified-origin') }).strict();
export type HelmRepositoryPage = z.infer<typeof helmRepositoryPageSchema>;
