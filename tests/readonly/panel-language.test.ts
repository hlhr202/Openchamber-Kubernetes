import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelLanguage, panelDirection, panelLocale, panelLocales, panelMessages, panelText } from '../../src/panel/i18n.ts';
import { explorerLabel, localizeExplorerActions } from '../../src/panel/explorer-localization.ts';
import { explorerTitleActions } from '../../src/shared/explorer-actions.ts';
import type { TreeEntry } from '../../src/shared/tree-entries.ts';

test('the bundled panel catalog covers the 15 OpenChamber 2.5.1 locales and preserves placeholders', () => {
  assert.deepEqual(panelLocales, ['en', 'de', 'fr', 'nl', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr', 'ar', 'he']);
  const slots = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, row] of Object.entries(panelMessages)) {
    assert.match(key, /^(?:[a-z][A-Za-z]+\.)+[a-z][A-Za-z]+$/);
    assert.equal(row.length, panelLocales.length, key);
    for (const [index, value] of row.entries()) {
      assert.ok(value.trim(), `${key}: ${panelLocales[index]}`);
      assert.deepEqual(slots(value), slots(row[0]), `${key}: ${panelLocales[index]}`);
    }
  }
});

test('host locale changes update language and direction once without changing the translated data', () => {
  const root = { lang: '', dir: '' }, changes: string[] = [];
  const hostReadyLocale = createPanelLanguage({ documentElement: root } as Document, locale => {
    assert.equal(root.lang, locale);
    assert.equal(root.dir, panelDirection(locale));
    changes.push(locale);
  });
  for (const locale of [...panelLocales, 'he-IL', 'iw', 'unknown', undefined]) hostReadyLocale(locale);
  assert.deepEqual(changes, [...panelLocales, 'en']);
  assert.equal(panelLocale('zh_Hant'), 'zh-TW');
  assert.equal(panelLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(panelLocale('PT_br'), 'pt-BR');
  assert.equal(panelLocale('pt-PT'), 'en');
  assert.notEqual(panelText('zh-CN', 'folder.custom'), panelText('zh-TW', 'folder.custom'));
  assert.equal(panelText('fr', 'explorer.actionsFor', '<b>{0}</b>'), 'Actions pour <b>{0}</b>');
});

test('translation only changes authored explorer labels, not target identity, command IDs or availability', () => {
  const target = { serviceGeneration: 'synthetic', projectId: 'a', configIdentity: 'config', context: 'local', namespace: 'default' };
  const entry: TreeEntry = { node: { id: 'node', type: 'folder', label: 'Custom Resources', expandable: true }, query: { kind: 'custom-types', target } };
  assert.equal(explorerLabel('fr', entry), 'Ressources personnalisées');
  assert.equal(explorerLabel('fr', { node: { ...entry.node, type: 'context' }, query: { kind: 'context', target } }), 'Custom Resources');
  const items = explorerTitleActions({ view: 'clusters', hasConfig: false, hasActiveContext: false, zh: false });
  const translated = localizeExplorerActions('fr', items);
  assert.equal(translated.find(item => item.id === 'extension.vsKubernetesRefreshExplorer')?.label, 'Actualiser');
  for (const [index, item] of translated.entries()) assert.deepEqual({ ...item, label: items[index]!.label }, items[index]);
});
