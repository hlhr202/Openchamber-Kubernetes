// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmTemplatePreviewRequestSchema, helmTemplatePreviewResponseSchema, isTemplatePath, noActiveEditorMessage, notATemplateMessage, previewTitle, noEditorLogText, saveNoEditorLogText, yamlParseFailedMessage, noOutputContent, errorDocumentTitle, errorDocumentSubtitle, templateArguments, skipsYamlValidation, previewDocument, saveShouldRefresh } from '../../src/shared/helm-template-preview-protocol.ts';
test('the request is a bare preview and the response is a strict sextet with a bounded title', () => {
  assert.equal(helmTemplatePreviewRequestSchema.safeParse({ protocol: 2, kind: 'preview' }).success, true);
  for (const bad of [{ kind: 'render' }, { kind: 'preview', filePath: '/x' }, { extra: 1 }]) assert.equal(helmTemplatePreviewRequestSchema.safeParse({ protocol: 2, kind: 'preview', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(helmTemplatePreviewResponseSchema.safeParse({ protocol: 2, kind: 'preview-opened', title: 'Preview service.yaml' }).success, true);
  for (const kind of ['no-active-editor', 'not-a-template', 'preview-rendered', 'preview-failed']) {
    if (kind === 'preview-rendered') assert.equal(helmTemplatePreviewResponseSchema.safeParse({ protocol: 2, kind, isErrorOutput: false }).success, true, kind);
    else assert.equal(helmTemplatePreviewResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  }
  assert.equal(helmTemplatePreviewResponseSchema.safeParse({ protocol: 2, kind: 'preview-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  for (const bad of [{ kind: 'preview-opened' }, { kind: 'preview-opened', title: '' }, { kind: 'preview-opened', title: 'a'.repeat(513) }, { kind: 'preview-rendered' }, { kind: 'preview-rendered', isErrorOutput: 'yes' }, { kind: 'preview-rendered', isErrorOutput: false, content: 'apiVersion: v1' }, { kind: 'preview-unavailable', code: 'NOPE' }, { kind: 'auto-saved' }]) assert.equal(helmTemplatePreviewResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the path gate, titles, messages and log texts are upstream verbatim', () => {
  assert.equal(isTemplatePath('/chart/templates/service.yaml'), true);
  assert.equal(isTemplatePath('/chart/values.yaml'), false);
  assert.equal(noActiveEditorMessage(), 'No active editor.');
  assert.equal(notATemplateMessage('/chart/values.yaml'), 'Not a template: /chart/values.yaml');
  assert.equal(previewTitle('service.yaml'), 'Preview service.yaml');
  assert.equal(noEditorLogText(), 'FIXME: no editor selected');
  assert.equal(saveNoEditorLogText(), 'WARNING: No active editor during save. Helm preview was not updated.');
  assert.equal(yamlParseFailedMessage('bad indentation'), 'YAML failed to parse: bad indentation');
  assert.equal(noOutputContent(), 'Helm template produced no output');
  assert.equal(errorDocumentTitle(), 'Chart Preview');
  assert.equal(errorDocumentSubtitle(), 'Failed template call');
});
test('the version branch, NOTES gate, document shape and save gate are upstream verbatim', () => {
  assert.deepEqual(templateArguments('/chart', 'templates/svc.yaml', 3), ['template', '"/chart"', '--show-only', '"templates/svc.yaml"']);
  assert.deepEqual(templateArguments('/chart', 'templates/svc.yaml', 4), ['template', '"/chart"', '--show-only', '"templates/svc.yaml"']);
  assert.deepEqual(templateArguments('/chart', 'templates/svc.yaml', 2), ['template', '"/chart"', '--execute', '"templates/svc.yaml"']);
  assert.equal(skipsYamlValidation('templates/NOTES.txt'), true);
  assert.equal(skipsYamlValidation('templates/svc.yaml'), false);
  assert.deepEqual(previewDocument('apiVersion: v1', 'templates/svc.yaml'), { title: 'templates/svc.yaml', content: 'apiVersion: v1', isErrorOutput: false });
  assert.deepEqual(previewDocument('', 'templates/svc.yaml'), { title: 'templates/svc.yaml', content: 'Helm template produced no output', isErrorOutput: true });
  assert.equal(saveShouldRefresh(true, true, 'file'), true);
  assert.equal(saveShouldRefresh(false, true, 'file'), false);
  assert.equal(saveShouldRefresh(true, false, 'file'), false);
  assert.equal(saveShouldRefresh(true, true, 'untitled'), false);
});
