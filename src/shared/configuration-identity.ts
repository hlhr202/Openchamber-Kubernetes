import { z } from 'zod';
import { boundedName } from './identity.ts';

// Configuration-only identity, not evidence of cluster reachability or host-authenticated project ownership.
export const configurationIdentitySchema = z.object({ serviceGeneration: z.string().uuid(), projectId: boundedName, configIdentity: boundedName }).strict();
export type ConfigurationIdentity = z.infer<typeof configurationIdentitySchema>;
