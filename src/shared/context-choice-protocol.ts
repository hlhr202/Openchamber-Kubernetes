import { z } from 'zod';
import { containsControlCharacters } from './identity.ts';
import { configPageSchema, configReadRequestSchema } from './protocol.ts';

export const contextSearchSchema = z.string().max(1024).refine(value => !containsControlCharacters(value));
export const contextChoiceRequestSchema = configReadRequestSchema.safeExtend({ search: contextSearchSchema });
export const contextChoicePageSchema = configPageSchema.safeExtend({ search: contextSearchSchema }).refine(value => value.contexts.every(context => !context.active && context.name.includes(value.search)));
export type ContextChoicePage = z.infer<typeof contextChoicePageSchema>;
