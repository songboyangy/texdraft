import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { applyMinimalReplace } from '../collab/hocuspocus.js';
import { normalizeProjectPath } from './paths.js';

test('normalizeProjectPath accepts normal paths', () => {
  assert.equal(normalizeProjectPath('./sections//intro.tex'), 'sections/intro.tex');
  assert.equal(normalizeProjectPath('/main.tex'), 'main.tex');
  assert.equal(normalizeProjectPath('a\\b.tex'), 'a/b.tex');
});

test('normalizeProjectPath rejects escapes', () => {
  for (const bad of ['../x.tex', 'a/../../x', '', '.', 'dir/', 'a\0b']) {
    assert.throws(() => normalizeProjectPath(bad), Error, bad);
  }
});

test('applyMinimalReplace only touches the changed span and keeps concurrent edits', () => {
  // 两个副本：A 由 Agent 修改中间一句，B 同时在文末追加内容；合并后两处修改都应保留
  const a = new Y.Doc();
  a.getText('t').insert(0, 'Hello world. The quick brown fox. Goodbye.');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

  const ta = a.getText('t');
  const old = 'The quick brown fox.';
  applyMinimalReplace(ta, ta.toString().indexOf(old), old, 'The quick red fox.');
  b.getText('t').insert(b.getText('t').length, ' P.S.');

  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(a.getText('t').toString(), 'Hello world. The quick red fox. Goodbye. P.S.');
  assert.equal(b.getText('t').toString(), a.getText('t').toString());
});

test('applyMinimalReplace handles pure insert / delete', () => {
  const d = new Y.Doc();
  const t = d.getText('t');
  t.insert(0, 'abcdef');
  applyMinimalReplace(t, 2, 'cd', 'cXd');
  assert.equal(t.toString(), 'abcXdef');
  applyMinimalReplace(t, 0, 'abcXdef', 'af');
  assert.equal(t.toString(), 'af');
});
