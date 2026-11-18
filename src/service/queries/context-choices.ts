import { contextChoicePageSchema } from '../../shared/context-choice-protocol.ts';
import { projectConfigPage } from './config-page.ts';
import type { ConfigRead } from './config-page.ts';

// Independent read-only projection over the FULL merged snapshot, not the currently visible configuration page.
export function projectContextChoices(result: ConfigRead, serviceGeneration: string, query: { search: string; page: { offset: number; limit: number; configIdentity?: string | undefined } }) {
  const contexts = result.snapshot.contexts.filter(context => !context.active && context.name.includes(query.search));
  const page = { offset: query.page.offset, limit: query.page.limit, ...(query.page.configIdentity !== undefined ? { configIdentity: query.page.configIdentity } : {}) };
  return contextChoicePageSchema.parse({ ...projectConfigPage(result, serviceGeneration, page, contexts), search: query.search });
}
