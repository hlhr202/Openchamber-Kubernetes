import { readFile } from 'node:fs/promises';

// These suites read the same frozen source files but never mutate them. Each
// worker keeps its own cache; this helper does not read generated artifacts.
const sources = new Map<string, Promise<string>>();
export function readSourceText(path: string): Promise<string> {
  const url = new URL(`../../${path}`, import.meta.url);
  const key = url.href;
  let text = sources.get(key);
  if (!text) {
    text = readFile(url, 'utf8');
    sources.set(key, text);
  }
  return text;
}
