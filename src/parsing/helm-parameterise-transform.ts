// Portable pure text transform only — the strict port of the parameterise core (locate the single
// `field: value` scalar assignment, swap in the .Values reference, emit the values entry).
// No filesystem, no buffers, no cluster, no execution. Bounds enforced on both ends.
import { BoundaryError } from '../shared/errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';
import { entryText, parameterReference } from '../shared/helm-parameterise-protocol.ts';

const inputBudget = 46_080, outputBudget = 46_080, lineBudget = 4000;
function containsDisallowedControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code < 32 && code !== 10 && code !== 9 || code === 127) return true; }
  return false;
}
const escapeLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A YAML scalar assignment for our tokens: `field: value` at any indentation, value to end of
// line, no trailing comment, no flow/quote container. The exact literal value is required.
const assignmentLine = (field: string, value: string) => new RegExp(`^(\\s*)${field}:\\s${escapeLiteral(value)}\\s*$`);

export function parameteriseDocument(documentText: string, template: string, field: string, value: string): { readonly document: string; readonly entry: string } {
  if (utf8ByteLength(documentText) > inputBudget || containsDisallowedControlCharacters(documentText) || !hasWellFormedUnicode(documentText)) throw new BoundaryError('INVALID_INPUT');
  const lines = documentText.split('\n');
  if (lines.length > lineBudget) throw new BoundaryError('BUDGET_EXCEEDED');
  const pattern = assignmentLine(field, value);
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index++) { const candidate = lines[index]; if (candidate !== undefined && pattern.test(candidate)) matches.push(index); }
  if (matches.length === 0) throw new BoundaryError('NOT_FOUND'); // upstream: Selection is not a YAML field
  if (matches.length > 1) throw new BoundaryError('STATE_UNAVAILABLE'); // ambiguity is explicit, never a guess
  const reference = parameterReference(template, field);
  const first = matches[0];
  const line = first === undefined ? undefined : lines[first];
  if (first === undefined || line === undefined) throw new BoundaryError('STATE_UNAVAILABLE');
  lines[first] = line.replace(pattern, `$1${field}: ${reference}`);
  const updated = lines.join('\n');
  const entry = entryText(template, field, value);
  if (utf8ByteLength(updated) > outputBudget || containsDisallowedControlCharacters(updated) || utf8ByteLength(entry) > 2048) throw new BoundaryError('BUDGET_EXCEEDED');
  return { document: updated, entry };
}

// Upstream addEntryToValuesFile shape: the top-level key is the template name, the nested key the
// field, the value the original literal.
export { entryText };
