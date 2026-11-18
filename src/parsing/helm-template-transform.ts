// Portable pure YAML transform only — the strict port of upstream templatise/cleanseMetadata/
// fixYamlValueQuoting. No filesystem, no cluster, no execution. Bounds are enforced before and after.
import { parse, stringify } from 'yaml';
import { BoundaryError } from '../shared/errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';

const inputBudget = 46_080, outputBudget = 46_080;
// Whole-document guard: newlines and tabs are legitimate YAML text; every other C0 control or DEL
// is rejected (scalar-level checks elsewhere use the stricter shared helper on short values).
function containsDisallowedControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code < 32 && code !== 10 && code !== 9 || code === 127) return true; }
  return false;
}
export const NAME_EXPRESSION = '{{ template "fullname" . }}';
export const CHART_LABEL_EXPRESSION = '{{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}';
const METADATA_TO_STRIP = ['clusterName', 'creationTimestamp', 'deletionTimestamp', 'generation', 'generateName', 'namespace', 'resourceVersion', 'selfLink', 'uid'] as const;
const ANNOTATIONS_TO_STRIP = ['kubectl.kubernetes.io/last-applied-configuration'] as const;
type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);

// Upstream templatise: ensure metadata/labels, cleanse cluster metadata, set the two template
// expressions, delete status. Single document only (upstream yaml.load takes one document).
export function convertToTemplateText(documentText: string): string {
  if (utf8ByteLength(documentText) > inputBudget || containsDisallowedControlCharacters(documentText) || !hasWellFormedUnicode(documentText)) throw new BoundaryError('INVALID_INPUT');
  let parsed: unknown;
  try { parsed = parse(documentText, { strict: false }); } catch { throw new BoundaryError('CONTENT_INVALID'); }
  if (parsed === null || parsed === undefined) throw new BoundaryError('CONTENT_INVALID');
  if (!isNode(parsed)) throw new BoundaryError('CONTENT_INVALID');
  const template: Node = parsed;
  const metadata = isNode(template.metadata) ? template.metadata : (template.metadata = {});
  if (!isNode(metadata.labels)) metadata.labels = {};
  for (const key of METADATA_TO_STRIP) delete metadata[key];
  if (isNode(metadata.annotations)) for (const key of ANNOTATIONS_TO_STRIP) delete metadata.annotations[key];
  metadata.name = NAME_EXPRESSION;
  (metadata.labels as Node).chart = CHART_LABEL_EXPRESSION;
  delete template.status;
  const text = fixYamlValueQuoting(stringify(template));
  if (utf8ByteLength(text) > outputBudget || containsDisallowedControlCharacters(text)) throw new BoundaryError('BUDGET_EXCEEDED');
  return text;
}

// Upstream fixYamlValueQuoting: the name expression must be unquoted, the chart label expression
// double-quoted (single-quoted scalars produced by the dumper are corrected post-hoc).
export function fixYamlValueQuoting(yamlText: string): string {
  let text = yamlText;
  text = text.replace(`'${NAME_EXPRESSION}'`, NAME_EXPRESSION);
  text = text.replace(`'${CHART_LABEL_EXPRESSION}'`, `"${CHART_LABEL_EXPRESSION}"`);
  return text;
}
