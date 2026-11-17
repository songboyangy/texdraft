import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTransformOutput } from '../agent/transform.js';
import { formatBibtex, makeCitationKey, parseArxivFeed, parseBibtexEntry } from './citations.js';

test('citation keys follow the Google Scholar style', () => {
  assert.equal(makeCitationKey(['Ashish Vaswani', 'Noam Shazeer'], 2017, 'Attention Is All You Need'), 'vaswani2017attention');
  assert.equal(makeCitationKey(['He, Kaiming'], 2016, 'Deep Residual Learning for Image Recognition'), 'he2016deep');
  assert.equal(makeCitationKey(['Jürgen Schmidhuber'], 2015, 'On the {LSTM}'), 'schmidhuber2015lstm');
  assert.equal(makeCitationKey([], undefined, 'A Survey'), 'anonsurvey');
});

test('parses BibTeX with nested braces and quoted values', () => {
  const e = parseBibtexEntry(
    '@article{Old_Key, title={On {BERT} and {GPT}}, author="Doe, Jane and Roe, R.", year=2020, journal={J. {AI} Res.}, abstract={long}}',
  );
  assert.ok(e);
  assert.equal(e.type, 'article');
  assert.equal(e.key, 'Old_Key');
  assert.deepEqual(Object.fromEntries(e.fields), {
    title: 'On {BERT} and {GPT}',
    author: 'Doe, Jane and Roe, R.',
    year: '2020',
    journal: 'J. {AI} Res.',
    abstract: 'long',
  });
  e.key = 'doe2020bert';
  const out = formatBibtex(e);
  assert.match(out, /^@article\{doe2020bert,\n {2}title {3}= \{On \{BERT\} and \{GPT\}\},\n {2}author {2}= /);
  assert.ok(!out.includes('abstract'), 'abstract is dropped');
  assert.ok(out.endsWith('\n}'));
});

test('parses the arXiv Atom feed', () => {
  const xml = `<feed><entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry></feed>`;
  const [r] = parseArxivFeed(xml);
  assert.equal(r.id, '1706.03762');
  assert.equal(r.title, 'Attention Is All You Need');
  assert.deepEqual(r.authors, ['Ashish Vaswani', 'Noam Shazeer']);
  assert.equal(r.year, 2017);
  assert.equal(r.category, 'cs.CL');
});

test('transform output cleanup strips stray fences and tags', () => {
  assert.equal(cleanTransformOutput('```latex\n\\textbf{x}\n```'), '\\textbf{x}');
  assert.equal(cleanTransformOutput('<selection>\nHello\n</selection>'), 'Hello');
  assert.equal(cleanTransformOutput('  plain  '), 'plain');
});
