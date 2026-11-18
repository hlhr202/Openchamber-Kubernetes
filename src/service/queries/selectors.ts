import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';

const labelName = /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;
const labelKey = z.string().min(1).max(317).refine(key => {
  const parts = key.split('/');
  const name = parts.at(-1);
  if (!name || !labelName.test(name) || parts.length > 2) return false;
  return parts.length === 1 || (!!parts[0] && parts[0].length <= 253 && parts[0].split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)));
});
const labelValue = z.string().max(63).regex(labelName);
const labelsSchema = z.record(labelKey, labelValue);
const selectorSchema = z.object({
  matchLabels: labelsSchema.optional(),
  matchExpressions: z.array(z.object({
    key: labelKey, operator: z.enum(['In', 'NotIn', 'Exists', 'DoesNotExist']), values: z.array(labelValue).max(256).optional(),
  }).strict()).max(256).optional(),
}).strict();
export type PodSelection = { readonly kind: 'empty' } | { readonly kind: 'selector'; readonly query: string };

export function normalizePodSelector(value: unknown, kind: 'workload' | 'service') {
  const selector = kind === 'service' ? { matchLabels: value } : value;
  const parsed = selectorSchema.safeParse(selector);
  if (!parsed.success) throw new BoundaryError('SELECTOR_INVALID');
  return parsed.data;
}

export function podSelection(value: unknown, kind: 'workload' | 'service'): PodSelection {
  const selector = normalizePodSelector(value, kind);
  const terms: string[] = [];
  for (const [key, label] of Object.entries(selector.matchLabels ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))) terms.push(`${key}=${label}`);
  for (const expression of selector.matchExpressions ?? []) {
    const values = expression.values ?? [];
    switch (expression.operator) {
      case 'In': case 'NotIn':
        if (!values.length) throw new BoundaryError('SELECTOR_INVALID');
        terms.push(`${expression.key} ${expression.operator === 'In' ? 'in' : 'notin'} (${values.join(',')})`);
        break;
      case 'Exists': case 'DoesNotExist':
        if (values.length) throw new BoundaryError('SELECTOR_INVALID');
        terms.push(`${expression.operator === 'DoesNotExist' ? '!' : ''}${expression.key}`);
    }
  }
  const query = terms.join(',');
  if (query.length > 16_000) throw new BoundaryError('BUDGET_EXCEEDED');
  return query ? { kind: 'selector', query } : { kind: 'empty' };
}

// Membership only, never label mutation or an unfiltered list fallback. NotIn matches absent keys.
export function matchesPodSelector(value: unknown, labelsInput: unknown): boolean {
  const selector = normalizePodSelector(value, 'workload');
  if (podSelection(selector, 'workload').kind === 'empty') return false;
  const parsed = labelsSchema.safeParse(labelsInput ?? {});
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const labels = parsed.data;
  for (const [key, expected] of Object.entries(selector.matchLabels ?? {})) if (!Object.hasOwn(labels, key) || labels[key] !== expected) return false;
  for (const expression of selector.matchExpressions ?? []) {
    const exists = Object.hasOwn(labels, expression.key), actual = labels[expression.key];
    if (expression.operator === 'In' && (!exists || !(expression.values ?? []).includes(actual ?? ''))) return false;
    if (expression.operator === 'NotIn' && exists && (expression.values ?? []).includes(actual ?? '')) return false;
    if (expression.operator === 'Exists' && !exists) return false;
    if (expression.operator === 'DoesNotExist' && exists) return false;
  }
  return true;
}
