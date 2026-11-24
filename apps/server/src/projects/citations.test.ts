import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTransformOutput } from '../agent/transform.js';
import { formatBibtex, fromOpenAlex, makeCitationKey, mergeResults, normalizeVenue, openalexBibtex, parseArxivFeed, parseBibtexEntry, pickCanonical } from './citations.js';

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

// ---- Search ranking: one record per paper, the original beats later reprints ----

const vaswaniAuthors = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'];

test('OpenAlex records: arXiv id from DOI or location, venue names cleaned up', () => {
  const [attn, vit] = fromOpenAlex([
    {
      id: 'https://openalex.org/W2963403868',
      doi: 'https://doi.org/10.48550/arxiv.1706.03762',
      display_name: 'Attention Is All You Need',
      publication_year: 2017,
      type: 'conference-paper',
      cited_by_count: 152843,
      authorships: vaswaniAuthors.map((n) => ({ author: { display_name: n } })),
      primary_location: { source: { display_name: 'neural information processing systems' } },
      locations: [{ landing_page_url: 'http://arxiv.org/abs/1706.03762' }],
    },
    {
      id: 'https://openalex.org/W3094502228',
      doi: null,
      display_name: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
      publication_year: 2020,
      type: 'preprint',
      cited_by_count: 72389,
      authorships: [{ author: { display_name: 'Alexey Dosovitskiy' } }],
      primary_location: { source: { display_name: 'arXiv (Cornell University)' } },
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2010.11929v2' }],
    },
  ]);
  assert.equal(attn.id, 'W2963403868');
  assert.equal(attn.arxivId, '1706.03762');
  assert.equal(attn.doi, undefined, 'arXiv DataCite DOI is not treated as a Crossref DOI');
  assert.equal(attn.venue, 'Advances in Neural Information Processing Systems');
  assert.equal(attn.citedBy, 152843);
  assert.equal(vit.arxivId, '2010.11929');
  assert.equal(vit.venue, undefined, 'arXiv is not a publication venue');
  assert.equal(normalizeVenue('international joint conference on artificial intelligence'), 'International Joint Conference on Artificial Intelligence');
  assert.equal(normalizeVenue('IEEE Transactions on Image Processing'), 'IEEE Transactions on Image Processing');
});

test('a DOI registered years later never replaces the original paper', () => {
  const reRegistered = { source: 'crossref' as const, id: '10.65215/ysbyhc05', title: 'Attention Is All You Need', authors: vaswaniAuthors, year: 2025, type: 'journal-article' };
  const original = {
    source: 'openalex' as const, id: 'W2963403868', title: 'Attention Is All You Need', authors: vaswaniAuthors, year: 2017,
    type: 'conference-paper', venue: 'Advances in Neural Information Processing Systems', citedBy: 152843, arxivId: '1706.03762',
  };
  const otherBook = { source: 'crossref' as const, id: '10.1201/9781003561460-19', title: 'Attention Is All You Need', authors: ['J. M. Bishop'], year: 2025, type: 'book-chapter', citedBy: 27 };
  const results = mergeResults('Attention Is All You Need', [[original], [reRegistered, otherBook], []]);
  assert.equal(results.length, 2, 'the re-registered DOI merges into the original');
  assert.equal(results[0].id, 'W2963403868');
  assert.equal(results[0].year, 2017);
  assert.equal(results[1].id, '10.1201/9781003561460-19', 'same title, different authors: the less cited paper ranks second');
});

test('the published version beats the preprint, and keeps the arXiv id', () => {
  const title = 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale';
  const preprint = { source: 'arxiv' as const, id: '2010.11929', title, authors: ['Alexey Dosovitskiy'], year: 2020, type: 'preprint' };
  const iclr = { source: 'openalex' as const, id: 'W3119786062', title, authors: ['Alexey Dosovitskiy'], year: 2021, type: 'conference-paper', venue: 'International Conference on Learning Representations', citedBy: 17085 };
  const picked = pickCanonical([preprint, iclr]);
  assert.equal(picked.id, 'W3119786062');
  assert.equal(picked.arxivId, '2010.11929');
  const entry = openalexBibtex(picked);
  assert.equal(entry.type, 'inproceedings');
  assert.deepEqual(Object.fromEntries(entry.fields).booktitle, 'International Conference on Learning Representations');
  assert.equal(Object.fromEntries(entry.fields).eprint, '2010.11929');
});

test('without a published version the arXiv record is used', () => {
  const title = 'A Brand New Preprint';
  const oa = { source: 'openalex' as const, id: 'W1', title, authors: ['Jane Doe'], year: 2026, type: 'preprint', citedBy: 3, arxivId: '2611.00001' };
  const ax = { source: 'arxiv' as const, id: '2611.00001', title, authors: ['Jane Doe'], year: 2026, type: 'preprint', category: 'cs.LG' };
  const picked = pickCanonical([oa, ax]);
  assert.equal(picked.source, 'arxiv');
  assert.equal(picked.citedBy, 3);
  const misc = openalexBibtex(oa);
  assert.equal(misc.type, 'misc');
});
