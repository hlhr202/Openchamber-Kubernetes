export type InspectionToken = { readonly text: string; readonly tone: 'plain' | 'key' | 'heading' | 'number' | 'muted' | 'success' | 'warning' | 'error' };
export const inspectionHighlightTokenLimit = 6000;

// Presentation only. Never parses HTML, follows links, executes ANSI or infers a
// resource's overall health from CLI text. Every character stays selectable/copyable.
export function inspectionTextTokens(text: string): readonly InspectionToken[] {
  const tokens: InspectionToken[] = [];
  const add = (text: string, tone: InspectionToken['tone'] = 'plain') => { if (text) tokens.push({ text, tone }); };
  let offset = 0;
  while (offset < text.length) {
    if (tokens.length >= inspectionHighlightTokenLimit - 8) { add(text.slice(offset)); break; }
    const end = text.indexOf('\n', offset), stop = end < 0 ? text.length : end + 1;
    const line = text.slice(offset, stop), ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    const body = ending ? line.slice(0, -ending.length) : line;
    // Bound the field name; URLs and arbitrary resource names do not become links.
    const field = /^([ \t]*)([A-Za-z][A-Za-z0-9 _./()-]{0,79}:)([ \t]*)(.*)$/.exec(body);
    if (field) {
      add(field[1] ?? '');
      add(field[2] ?? '', (field[4] ?? '') ? 'key' : 'heading');
      add(field[3] ?? '');
      const value = field[4] ?? '', key = field[2]?.toLowerCase();
      if (key === 'exit code:' && /^-?\d+$/.test(value.trim())) add(value, Number(value) === 0 ? 'success' : 'error');
      else if (key === 'ready:' && value.trim() === 'False') add(value, 'error');
      else if (value.trim() === '<none>') add(value, 'muted');
      else highlightValue(value, add, inspectionHighlightTokenLimit - tokens.length - 1);
    } else if (/^[ \t]*(?:Events:|Conditions:|Containers:|Init Containers:|NAME[ \t]{2,})/.test(body)) add(body, 'heading');
    else highlightValue(body, add, inspectionHighlightTokenLimit - tokens.length - 1);
    add(ending);
    offset = stop;
  }
  return tokens;
}

function highlightValue(value: string, add: (text: string, tone?: InspectionToken['tone']) => void, budget: number) {
  const words = /\b(?:CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|CreateContainerError|RunContainerError|InvalidImageName|Failed|Error|Warning|Pending|Waiting|ContainerCreating|PodInitializing|NotReady|Running|Ready|True|False|Succeeded|Completed|Normal|\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|m|s|h|d)?)\b/g;
  let offset = 0, count = 0;
  for (const match of value.matchAll(words)) {
    // Bounded tokens per line, too: a single huge line must not create unbounded DOM.
    if (count + 2 >= budget) break;
    add(value.slice(offset, match.index));
    const word = match[0];
    const tone = /BackOff|Error|ErrImagePull|InvalidImageName|Failed/.test(word) ? 'error'
      : /^(Warning|Pending|Waiting|ContainerCreating|PodInitializing|NotReady|False)$/.test(word) ? 'warning'
        : /^(Running|Ready|True|Succeeded|Completed|Normal)$/.test(word) ? 'success' : 'number';
    add(word, tone);
    count += 2;
    offset = match.index + word.length;
  }
  add(value.slice(offset));
}

export function renderInspectionText(document: Document, pre: HTMLElement, text: string): void {
  const nodes = inspectionTextTokens(text).map(token => {
    const span = document.createElement('span');
    if (token.tone !== 'plain') span.className = `oc-k8s-syntax-${token.tone}`;
    span.textContent = token.text; // Never inject markup from resources or CLI output.
    return span;
  });
  pre.replaceChildren(...nodes);
}
