// Text-only static wiring; no UI/SDK, file adapters, writer or confirmation/commit handler execution.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('bundle analysis is a lazy bounded AST walk, not text splitting, JS conversion or a write plan', async () => {
  const code = await file('src/parsing/manifest-bundle.ts'); assert.ok(code.includes('composer.compose(new Parser().parse(text)') && code.includes('documents.length >= 32') && code.includes('nodes > 20_000') && code.includes('item.depth > 32') && code.includes('parseDocumentJson(text)'));
  assert.ok(!/\.toJS\(|\.toJSON\(|\.toString\(|JSON\.stringify|operations\/|adapters\/|fetch\(|writeFile|spawn\(|eval\(/.test(code));
});
test('buffer selection increments local revision without changing origin/text and editing invalidates analysis', async () => {
  const code = await file('src/shared/document-buffer.ts'); assert.ok(code.includes('this.#analysis = undefined; this.#activeDocument = 0') && code.includes('index !== this.#activeDocument') && code.includes('this.#activeDocument = index; this.#revision++'));
});
test('client and bridge expose explicit pure analysis/selection, still separate from any Save/Apply/G4 control chain', async () => {
  const client = await file('src/host/document-client.ts'), bridge = await file('src/host/bridge.ts'); assert.ok(client.includes('this.#buffer.analyse(analyseManifestBundle(') && client.includes('this.#buffer.selectDocument(index)') && bridge.includes('analyseDocument: () => documents.analyse()') && bridge.includes('selectDocument: (index: number) => documents.selectDocument(index)'));
  assert.ok(!/operations\/|adapters\/|\.prepare\(|\.submit\(|writeFile|storage\./.test(client)); assert.ok(bridge.includes('documentState = state; fileSaves?.changed(); manifestDiff?.changed(); explanations.reset(); showDocument(state)'));
});
test('Explain uses the selected source span and rechecks current revision/GVK, never adds document bodies to its wire schema', async () => {
  const fields = await file('src/host/document-fields.ts'), view = await file('src/panel/explain-view.ts'), protocol = await file('src/shared/explain-protocol.ts'); assert.ok(fields.includes('documentFields(bufferDocumentText(state.editor), state.source.reference.type)') && view.includes('documentFields(bufferDocumentText(doc.editor), doc.source.reference.type)'));
  assert.ok(fields.includes('revision !== state.editor.revision') && fields.includes("string('kind') !== type.kind")); assert.ok(!/text:|body:|documentIndex:/.test(protocol));
});
test('SDK controls analyse only on explicit click, show syntax-only disclosure and release their local state on disposal', async () => {
  const view = await file('src/panel/document-view.ts'); assert.ok(view.includes('onClick: () => bridge()?.analyseDocument()') && view.includes('bridge()?.selectDocument(Number(id))') && view.includes('syntax/AST only, not Apply validation') && view.includes('analyse.dispose(); picker.dispose()')); assert.ok(!/innerHTML|localStorage|storage\.|writeFile|setInterval/.test(view));
});
test('new functional suites are allowlisted and import no real filesystem/SDK or operation/execution boundaries', async () => {
  const tests = await file('tests/readonly/manifest-bundle.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts'); assert.ok(readonly.includes("'tests/readonly/manifest-bundle.test.ts'") && statics.includes("'tests/static/manifest-bundle-wiring.test.ts'")); assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(tests));
});
test('shared summary/buffer contracts never import the YAML parser or host modules, without weakening source boundaries', async () => {
  const contract = await file('src/shared/manifest-bundle.ts'), buffer = await file('src/shared/document-buffer.ts'), check = await file('scripts/check-static.ts');
  assert.ok(!/from ['"](?:yaml|\.\.\/host\/)/.test(contract + buffer));
  assert.ok(check.includes("path.startsWith('src/shared/') && !(resolved.startsWith('src/shared/') || specifier === 'zod')"));
  assert.ok(check.includes("path.startsWith('src/parsing/') && !(resolved.startsWith('src/parsing/') || resolved.startsWith('src/shared/') || specifier === 'yaml')"));
});
