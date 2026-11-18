import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { helmRepositoryName } from './helm-repository-protocol.ts';

// Upstream insertRequirement (helm.exec.ts#L897-L950): an input "repo/chart" is looked up in the
// user's repositories.yaml plus the cached index (searchForChart) and a Requirement
// {repository: repo.url, name, version: releases[0].version} is inserted into the ACTIVE EDITOR as
// a snippet (or logged when no editor is open). Here the lookup reuses the SAME read-only
// repository-file boundary and pure projections as the repository explorer; the requirement text
// keeps the upstream shape but references the repository by its `@alias` instead of the raw URL —
// repository URLs (which can embed credentials) NEVER leave the read boundary (disclosed
// deviation). Nothing is inserted into any document or clipboard automatically: the bounded text
// is displayed for the human to place (upstream insertion is a host editor action).
export const helmRequirementRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), repository: helmRepositoryName, chart: helmRepositoryName }).strict(),
]);
export type HelmRequirementRequest = z.infer<typeof helmRequirementRequestSchema>;
export const helmRequirementResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-requirement'), repository: helmRepositoryName, chart: helmRepositoryName, version: z.string().min(1).max(256), text: z.string().max(512) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-requirement-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmRequirementResponse = z.infer<typeof helmRequirementResponseSchema>;
// Upstream Requirement.toString() shape with the @alias repository reference (URLs stay inside).
export function requirementText(repository: string, chart: string, version: string): string {
  return `- name: ${chart}\n  version: ${version}\n  repository: @${repository}\n`;
}
