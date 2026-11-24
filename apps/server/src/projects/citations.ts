import type { CitationSearchResult } from '@texdraft/shared';
import { readText, transactText } from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { badRequest } from '../lib/http.js';
import { createTextFile, listFiles } from './service.js';

/**
 * 文献检索与 BibTeX 管理：
 *  - 在线检索 Crossref（带 DOI 的期刊/会议论文）、arXiv（预印本）与 OpenAlex（无 DOI 的会议论文、引用量），无需 API Key
 *  - 获取 BibTeX：有 Crossref DOI 的用其官方转换接口；arXiv 与 OpenAlex 根据元数据生成
 *  - 统一生成 Google Scholar 风格的键（vaswani2017attention），追加到项目 .bib，按 DOI / arXiv 号去重
 */

const UA = 'TeXdraft (open-source LaTeX editor; https://github.com/songboyangy/texdraft)';
const TIMEOUT = 12_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
}

// ---------------------------------------------------------------------------
// 检索
//  - Crossref：带 DOI 的期刊 / 会议论文
//  - arXiv：预印本（最新的论文）
//  - OpenAlex：收录没有 DOI 的会议论文（NeurIPS、ICLR…）并提供引用量，arXiv 不可用时也能查到预印本
// 同一篇论文的多条记录合并为一条：优先最早发表的正式版本，后来的转载 / 再注册的 DOI 被淘汰
// ---------------------------------------------------------------------------

interface CrossrefItem {
  DOI: string;
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  type?: string;
  'is-referenced-by-count'?: number;
}

function fromCrossref(items: CrossrefItem[]): CitationSearchResult[] {
  return items
    .filter((it) => it.title?.[0])
    .map((it) => ({
      source: 'crossref' as const,
      id: it.DOI,
      title: stripTags(it.title![0]),
      authors: (it.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0] ?? undefined,
      venue: it['container-title']?.[0] ? stripTags(it['container-title'][0]) : undefined,
      type: it.type,
      url: `https://doi.org/${it.DOI}`,
      citedBy: it['is-referenced-by-count'],
    }));
}

async function searchCrossref(query: string, rows: number): Promise<CitationSearchResult[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,issued,container-title,type,is-referenced-by-count`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Crossref ${res.status}`);
  const data = (await res.json()) as { message?: { items?: CrossrefItem[] } };
  return fromCrossref(data.message?.items ?? []);
}

async function crossrefByDoi(doi: string): Promise<CitationSearchResult[]> {
  const res = await fetchWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Crossref ${res.status}`);
  const data = (await res.json()) as { message?: CrossrefItem };
  return data.message ? fromCrossref([data.message]) : [];
}

function xmlText(s: string | undefined) {
  return (s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseArxivFeed(xml: string): CitationSearchResult[] {
  const out: CitationSearchResult[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const idUrl = xmlText(/<id>([\s\S]*?)<\/id>/.exec(e)?.[1]);
    const id = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    const title = xmlText(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1]);
    if (!id || !title) continue;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => xmlText(a[1]));
    const published = xmlText(/<published>([\s\S]*?)<\/published>/.exec(e)?.[1]);
    const category = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(e)?.[1];
    const doi = xmlText(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(e)?.[1]) || undefined;
    out.push({
      source: 'arxiv',
      id,
      title,
      authors,
      year: published ? Number(published.slice(0, 4)) : undefined,
      venue: category ? `arXiv:${id} [${category}]` : `arXiv:${id}`,
      type: 'preprint',
      url: `https://arxiv.org/abs/${id}`,
      doi,
      category,
    });
  }
  return out;
}

/** arXiv asks API clients for at most one request every 3 seconds: requests from this process are spaced that far apart */
const ARXIV_SPACING_MS = 3000;
const ARXIV_MAX_WAIT_MS = 6000;
let arxivNextAt = 0;
async function arxivSlot() {
  const now = Date.now();
  const wait = arxivNextAt - now;
  if (wait > ARXIV_MAX_WAIT_MS) throw new Error('arXiv busy');
  arxivNextAt = Math.max(now, arxivNextAt) + ARXIV_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

async function arxivQuery(params: string) {
  for (let attempt = 0; ; attempt++) {
    await arxivSlot();
    const res = await fetchWithTimeout(`https://export.arxiv.org/api/query?${params}`);
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      await res.body?.cancel();
      continue; // one retry, after the next 3-second slot
    }
    if (!res.ok) throw new Error(`arXiv ${res.status}`);
    return parseArxivFeed(await res.text());
  }
}

async function searchArxiv(query: string, max: number): Promise<CitationSearchResult[]> {
  // 一个请求：标题短语匹配（论文名检索最准）或所有词都出现（关键词检索）
  const words = query.replace(/["():[\]{}]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  if (!words.length) return [];
  const sq = `ti:"${words.join(' ')}" OR (${words.map((w) => `all:${w}`).join(' AND ')})`;
  return arxivQuery(`search_query=${encodeURIComponent(sq)}&start=0&max_results=${max}&sortBy=relevance`);
}

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  type?: string | null;
  cited_by_count?: number;
  authorships?: { author?: { display_name?: string | null } }[];
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  locations?: { landing_page_url?: string | null }[] | null;
}

const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const OPENALEX_SELECT = 'id,doi,display_name,publication_year,type,cited_by_count,authorships,primary_location,locations';
/** OpenAlex writes some venue names in lower case; the common ML venues get their usual BibTeX names */
const VENUES: Record<string, string> = {
  'neural information processing systems': 'Advances in Neural Information Processing Systems',
  'international conference on learning representations': 'International Conference on Learning Representations',
  'international conference on machine learning': 'International Conference on Machine Learning',
};
const SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

export function normalizeVenue(v: string) {
  const known = VENUES[v.trim().toLowerCase()];
  if (known) return known;
  if (v !== v.toLowerCase()) return v;
  return v.replace(/[a-z]+/g, (w, offset: number) => (offset > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

export function fromOpenAlex(works: OpenAlexWork[]): CitationSearchResult[] {
  const out: CitationSearchResult[] = [];
  for (const w of works) {
    const title = w.display_name ? stripTags(w.display_name) : '';
    if (!title || !w.id) continue;
    const rawDoi = w.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase() || undefined;
    const arxivFromDoi = rawDoi ? ARXIV_DOI.exec(rawDoi)?.[1] : undefined;
    const arxivFromLocation = (w.locations ?? [])
      .map((l) => /arxiv\.org\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/i.exec(l.landing_page_url ?? '')?.[1])
      .find(Boolean);
    const arxivId = (arxivFromDoi ?? arxivFromLocation)?.replace(/v\d+$/, '');
    const doi = rawDoi && !arxivFromDoi ? rawDoi : undefined;
    const venueName = w.primary_location?.source?.display_name ?? undefined;
    const venue = venueName && !/arxiv/i.test(venueName) ? normalizeVenue(venueName) : undefined;
    const id = w.id.replace(/^https?:\/\/openalex\.org\//, '');
    out.push({
      source: 'openalex',
      id,
      title,
      authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
      year: w.publication_year ?? undefined,
      venue,
      type: w.type ?? undefined,
      citedBy: w.cited_by_count,
      doi,
      arxivId,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : `https://openalex.org/${id}`,
    });
  }
  return out;
}

function openalexUrl(path: string, params: Record<string, string>) {
  const u = new URL(`https://api.openalex.org/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (config.citations.openalexApiKey) u.searchParams.set('api_key', config.citations.openalexApiKey);
  if (config.citations.openalexEmail) u.searchParams.set('mailto', config.citations.openalexEmail);
  return u.toString();
}

async function searchOpenAlex(query: string, rows: number): Promise<CitationSearchResult[]> {
  const res = await fetchWithTimeout(openalexUrl('works', { search: query, 'per-page': String(rows), select: OPENALEX_SELECT }));
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = (await res.json()) as { results?: OpenAlexWork[] };
  return fromOpenAlex(data.results ?? []);
}

async function openalexByDoi(doi: string): Promise<CitationSearchResult[]> {
  const res = await fetchWithTimeout(openalexUrl(`works/doi:${encodeURI(doi)}`, { select: OPENALEX_SELECT }));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  return fromOpenAlex([(await res.json()) as OpenAlexWork]);
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const ARXIV_ID = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;
/** 去重用的论文身份：规范化标题 + 第一作者姓 */
function identity(r: CitationSearchResult) {
  const first = r.authors[0] ?? '';
  const family = (first.includes(',') ? first.split(',')[0] : first.split(/\s+/).pop() ?? '').toLowerCase();
  return `${normTitle(r.title)}|${asciiFold(family)}`;
}
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || /\p{Script=Han}/u.test(w)));

const FORMAL_TYPES = /^(journal-article|proceedings-article|book-chapter|book|monograph|article|conference-paper|review|letter)$/;
/** A peer-reviewed / published version (not a preprint) */
function isFormal(r: CitationSearchResult) {
  if (r.source === 'arxiv') return false;
  if (r.source === 'openalex' && !r.venue) return false; // arXiv-only record
  return FORMAL_TYPES.test(r.type ?? '');
}
const SOURCE_ORDER = { crossref: 0, openalex: 1, arxiv: 2 } as const;

/**
 * One record for a paper found several times (same title and first author):
 *  - only versions from within a year of the first appearance count, so a reprint or a DOI registered years later never wins
 *  - among those, the published version beats the preprint; then the earliest, then the most cited
 */
export function pickCanonical(group: CitationSearchResult[]): CitationSearchResult {
  const years = group.map((r) => r.year).filter((y): y is number => !!y);
  const earliest = years.length ? Math.min(...years) : undefined;
  const near = group.filter((r) => earliest === undefined || !r.year || r.year <= earliest + 1);
  const formal = near.filter(isFormal);
  const pool = formal.length ? formal : near;
  const preferArxiv = !formal.length;
  const best = [...pool].sort(
    (a, b) =>
      (a.year ?? 9999) - (b.year ?? 9999) ||
      (preferArxiv ? Number(b.source === 'arxiv') - Number(a.source === 'arxiv') : 0) ||
      (b.citedBy ?? 0) - (a.citedBy ?? 0) ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
  )[0];
  const citedBy = Math.max(0, ...group.map((r) => r.citedBy ?? 0)) || undefined;
  const arxivId = best.source === 'arxiv' ? undefined : best.arxivId ?? group.find((r) => r.source === 'arxiv')?.id ?? group.find((r) => r.arxivId)?.arxivId;
  return { ...best, ...(citedBy ? { citedBy } : {}), ...(arxivId ? { arxivId } : {}) };
}

/** 标题与查询的相似度：完全一致 > 覆盖查询词的比例 > 标题冗余程度；正式出版物略优先 */
export function relevance(query: string, r: CitationSearchResult) {
  const q = tokens(query);
  const t = tokens(r.title);
  if (!q.size || !t.size) return 0;
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  let score = (hit / q.size) * 0.7 + (hit / t.size) * 0.3;
  if (normTitle(r.title) === normTitle(query)) score += 1;
  if (isFormal(r)) score += 0.05;
  if (r.source === 'crossref' && /^(posted-content|peer-review|component|other)$/.test(r.type ?? '')) score -= 0.1;
  return score;
}

/** Title match first; among similar matches the more cited paper (an exact-title match still beats any citation count) */
export function rankScore(query: string, r: CitationSearchResult) {
  return relevance(query, r) + 0.04 * Math.log10(1 + (r.citedBy ?? 0));
}

/** Merge results from all sources into one record per paper and rank them against the query */
export function mergeResults(query: string | null, lists: CitationSearchResult[][]) {
  const groups = new Map<string, CitationSearchResult[]>();
  for (const r of lists.flat()) {
    const k = identity(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const merged = [...groups.values()].map(pickCanonical);
  if (query === null) return merged;
  return merged
    .map((r, i) => ({ r, i, s: rankScore(query, r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
    .slice(0, 14);
}

function settleWithin<T>(p: Promise<T>, ms: number): Promise<PromiseSettledResult<T>> {
  return Promise.race([
    p.then(
      (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
      (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
    ),
    sleep(ms).then((): PromiseSettledResult<T> => ({ status: 'rejected', reason: new Error('no response in time') })),
  ]);
}

type SearchOutcome = { results: CitationSearchResult[]; errors: string[] };
const searchCache = new Map<string, { at: number; value: SearchOutcome }>();
const CACHE_TTL_MS = 30 * 60_000;
/** Results with a failed source are kept briefly, so retrying the same search does not wait on that source again */
const PARTIAL_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
/** arXiv is the slowest source and the one most often rate limited: once the others have answered, wait at most this long for it */
const ARXIV_GRACE_MS = 2500;

/** 并行检索三个来源；某个来源失败不影响其他来源。完整成功的结果缓存 30 分钟 */
export async function searchOnline(query: string): Promise<SearchOutcome> {
  const q = query.trim();
  if (q.length < 2) throw badRequest('Query too short');
  const key = q.toLowerCase().replace(/\s+/g, ' ');
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < (hit.value.errors.length ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS)) return hit.value;
  const value = await searchAll(q);
  if (!value.errors.length || value.results.length) {
    searchCache.delete(key);
    searchCache.set(key, { at: Date.now(), value });
    if (searchCache.size > CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
  }
  return value;
}

async function searchAll(q: string): Promise<SearchOutcome> {
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i.exec(q)?.[1];
  // arXiv's own DOIs (10.48550/arXiv.…) are registered with DataCite, not Crossref: look them up as arXiv ids
  const arxivId = ARXIV_ID.exec(q)?.[1] ?? (doi ? ARXIV_DOI.exec(doi)?.[1] : undefined);
  const lookup = Boolean(doi || arxivId);
  const none = Promise.resolve([] as CitationSearchResult[]);
  const arxiv = arxivId ? arxivQuery(`id_list=${arxivId}`) : doi ? none : searchArxiv(q, 6);
  const [crossref, openalex] = await Promise.allSettled([
    arxivId ? none : doi ? crossrefByDoi(doi) : searchCrossref(q, 10),
    arxivId ? openalexByDoi(`10.48550/arxiv.${arxivId}`) : doi ? openalexByDoi(doi) : searchOpenAlex(q, 10),
  ]);
  const settled = [crossref, await settleWithin(arxiv, ARXIV_GRACE_MS), openalex];
  const names = ['Crossref', 'arXiv', 'OpenAlex'];
  const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  const errors = settled.flatMap((s, i) => {
    if (s.status === 'fulfilled') return [];
    const msg = String((s.reason as Error)?.message ?? s.reason);
    return [msg.startsWith(names[i]) ? msg : `${names[i]}: ${msg}`];
  });
  // 按 DOI / arXiv 编号查时只要有一个来源找到就够了；Crossref 的结果放前面（BibTeX 来自官方接口）
  if (lookup) {
    const results = mergeResults(null, [lists[0], lists[2], lists[1]]);
    return { results, errors: results.length ? [] : errors };
  }
  return { results: mergeResults(q, [lists[2], lists[0], lists[1]]), errors };
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'in', 'to', 'and', 'with', 'via', 'towards', 'toward', 'is', 'are', 'from', 'by', 'at', 'as']);

function asciiFold(s: string) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
}

/** Google Scholar 风格：第一作者姓 + 年份 + 标题首个实词 */
export function makeCitationKey(authors: string[], year: number | undefined, title: string) {
  const first = authors[0] ?? '';
  const family = first.includes(',') ? first.split(',')[0] : first.split(/\s+/).pop() ?? '';
  const last = asciiFold(family).toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const word = asciiFold(title)
    .toLowerCase()
    .replace(/[{}\\$]/g, '')
    .split(/[^a-z0-9]+/)
    .find((w) => w.length > 1 && !STOP.has(w)) ?? '';
  return `${last}${year ?? ''}${word}`;
}

interface BibEntry {
  type: string;
  key: string;
  fields: [string, string][];
}

/** 解析单条 BibTeX（支持嵌套花括号与引号值） */
export function parseBibtexEntry(src: string): BibEntry | null {
  const head = /@\s*(\w+)\s*[{(]\s*([^,\s]+)\s*,/.exec(src);
  if (!head) return null;
  const fields: [string, string][] = [];
  let i = head.index + head[0].length;
  while (i < src.length) {
    const m = /\s*([A-Za-z][\w-]*)\s*=\s*/y;
    m.lastIndex = i;
    const fm = m.exec(src);
    if (!fm) break;
    i = m.lastIndex;
    let value = '';
    if (src[i] === '{') {
      let depth = 0;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      value = src.slice(start + 1, i);
      i++;
    } else if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      value = src.slice(i + 1, end);
      i = end + 1;
    } else {
      const vm = /[^,}\s]+/y;
      vm.lastIndex = i;
      value = vm.exec(src)?.[0] ?? '';
      i = vm.lastIndex;
    }
    fields.push([fm[1].toLowerCase(), value.replace(/\s+/g, ' ').trim()]);
    const comma = /\s*,?/y;
    comma.lastIndex = i;
    comma.exec(src);
    i = comma.lastIndex;
  }
  return { type: head[1].toLowerCase(), key: head[2], fields };
}

const FIELD_ORDER = ['title', 'author', 'editor', 'booktitle', 'journal', 'volume', 'number', 'pages', 'year', 'month', 'publisher', 'organization', 'school', 'institution', 'eprint', 'archiveprefix', 'primaryclass', 'doi', 'url'];

export function formatBibtex(e: BibEntry) {
  const fields = [...e.fields]
    .filter(([k]) => !['abstract', 'file', 'keywords'].includes(k))
    .sort((a, b) => {
      const ia = FIELD_ORDER.indexOf(a[0]);
      const ib = FIELD_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const width = Math.max(...fields.map(([k]) => k.length));
  return `@${e.type}{${e.key},\n${fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(',\n')}\n}`;
}

function bibEscape(s: string) {
  return s.replace(/([&%#_])/g, '\\$1');
}

async function crossrefBibtex(doi: string): Promise<BibEntry> {
  const res = await fetchWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`);
  if (!res.ok) throw new Error(`Crossref BibTeX ${res.status}`);
  const entry = parseBibtexEntry(await res.text());
  if (!entry) throw new Error('Could not parse BibTeX from Crossref');
  if (!entry.fields.some(([k]) => k === 'doi')) entry.fields.push(['doi', doi]);
  return entry;
}

function arxivBibtex(r: CitationSearchResult): BibEntry {
  const fields: [string, string][] = [
    ['title', bibEscape(r.title)],
    ['author', r.authors.map(bibEscape).join(' and ')],
    ['year', String(r.year ?? '')],
    ['eprint', r.id],
    ['archiveprefix', 'arXiv'],
  ];
  if (r.category) fields.push(['primaryclass', r.category]);
  if (r.doi) fields.push(['doi', r.doi]);
  fields.push(['url', `https://arxiv.org/abs/${r.id}`]);
  return { type: 'misc', key: '', fields };
}

/** BibTeX from OpenAlex metadata, for papers without a Crossref DOI (NeurIPS, ICLR, ICML… and arXiv-only papers) */
export function openalexBibtex(r: CitationSearchResult): BibEntry {
  const conference = r.type === 'conference-paper' || r.type === 'proceedings-article';
  const type = !r.venue ? 'misc' : conference ? 'inproceedings' : r.type === 'book-chapter' ? 'incollection' : 'article';
  const fields: [string, string][] = [
    ['title', bibEscape(r.title)],
    ['author', r.authors.map(bibEscape).join(' and ')],
  ];
  if (r.venue) fields.push([type === 'article' ? 'journal' : 'booktitle', bibEscape(r.venue)]);
  if (r.year) fields.push(['year', String(r.year)]);
  if (r.arxivId) fields.push(['eprint', r.arxivId], ['archiveprefix', 'arXiv']);
  if (r.doi) fields.push(['doi', r.doi]);
  fields.push(['url', r.url ?? (r.arxivId ? `https://arxiv.org/abs/${r.arxivId}` : `https://openalex.org/${r.id}`)]);
  return { type, key: '', fields };
}

async function openalexEntry(r: CitationSearchResult): Promise<BibEntry> {
  if (r.doi) {
    try {
      return await crossrefBibtex(r.doi);
    } catch {
      /* DOI registered outside Crossref (DataCite…): build the entry from OpenAlex metadata */
    }
  }
  return openalexBibtex(r);
}

/** Identifiers under which the paper may already be in the project's .bib */
function citationIds(r: CitationSearchResult) {
  const ids: string[] = [];
  if (r.source === 'crossref') ids.push(`doi:${r.id.toLowerCase()}`);
  if (r.source === 'arxiv') ids.push(`arxiv:${r.id.toLowerCase()}`, `doi:10.48550/arxiv.${r.id.toLowerCase()}`);
  if (r.doi) ids.push(`doi:${r.doi.toLowerCase()}`);
  if (r.arxivId) ids.push(`arxiv:${r.arxivId.toLowerCase()}`, `doi:10.48550/arxiv.${r.arxivId.toLowerCase()}`);
  return ids;
}

/** 读取项目内所有 .bib：键集合 + 每条的 DOI / eprint（用于去重） */
async function projectBibIndex(projectId: string) {
  const bibs = (await listFiles(projectId)).filter((f) => f.kind === 'text' && f.path.endsWith('.bib'));
  const keys = new Set<string>();
  const byId = new Map<string, string>();
  for (const f of bibs) {
    const text = await readText(f.id);
    for (const m of text.matchAll(/@\w+\s*[{(]\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
      keys.add(m[1]);
      const doi = /\bdoi\s*=\s*[{"]\s*([^}"]+)/i.exec(m[2])?.[1]?.trim().toLowerCase();
      const eprint = /\beprint\s*=\s*[{"]\s*([^}"]+)/i.exec(m[2])?.[1]?.trim().toLowerCase();
      if (doi) byId.set(`doi:${doi}`, m[1]);
      if (eprint) byId.set(`arxiv:${eprint.replace(/v\d+$/, '')}`, m[1]);
    }
  }
  return { bibs, keys, byId };
}

/** 项目中是否已经声明了参考文献（\bibliography / \addbibresource / \printbibliography / thebibliography） */
async function hasBibliographyCommand(projectId: string) {
  for (const f of await listFiles(projectId)) {
    if (f.kind !== 'text' || !f.path.endsWith('.tex')) continue;
    const text = (await readText(f.id)).replace(/(^|[^\\])%.*$/gm, '$1');
    if (/\\(bibliography|addbibresource|printbibliography)\b|\\begin\{thebibliography\}/.test(text)) return true;
  }
  return false;
}

/** 把检索结果加入项目 .bib（已存在则复用原键），返回可直接 \cite 的键 */
export async function addCitation(projectId: string, r: CitationSearchResult) {
  const index = await projectBibIndex(projectId);
  const dupKey = citationIds(r).map((id) => index.byId.get(id)).find(Boolean);
  const target = index.bibs[0];
  if (dupKey) {
    return { key: dupKey, bibPath: target?.path ?? '', added: false, needsBibliography: !(await hasBibliographyCommand(projectId)) };
  }

  const entry = r.source === 'crossref' ? await crossrefBibtex(r.id) : r.source === 'arxiv' ? arxivBibtex(r) : await openalexEntry(r);
  let key = makeCitationKey(r.authors, r.year, r.title);
  for (let n = 0; index.keys.has(key); n++) key = `${makeCitationKey(r.authors, r.year, r.title)}${String.fromCharCode(97 + n)}`;
  entry.key = key;
  const bibtex = formatBibtex(entry);

  let bibPath: string;
  if (target) {
    bibPath = target.path;
    await transactText(target.id, 'citation', (y) => {
      const text = y.toString();
      y.insert(text.length, `${text.length && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : ''}${bibtex}\n`);
    });
  } else {
    bibPath = 'refs.bib';
    await createTextFile(projectId, bibPath, `${bibtex}\n`);
  }
  return { key, bibPath, added: true, bibtex, needsBibliography: !(await hasBibliographyCommand(projectId)) };
}

/** 在主文件 \end{document} 前插入 \bibliographystyle + \bibliography */
export async function addBibliographyToMain(projectId: string) {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  const files = await listFiles(projectId);
  const main = files.find((f) => f.path === project?.mainFile && f.kind === 'text');
  const bib = files.find((f) => f.kind === 'text' && f.path.endsWith('.bib'));
  if (!main || !bib) throw badRequest('Main file or .bib file not found');
  const bibName = bib.path.replace(/\.bib$/, '');
  return transactText(main.id, 'citation', (y) => {
    const text = y.toString();
    const idx = text.lastIndexOf('\\end{document}');
    const snippet = `\\bibliographystyle{plain}\n\\bibliography{${bibName}}\n\n`;
    if (idx < 0) y.insert(text.length, `\n${snippet}`);
    else y.insert(idx, snippet);
    return { mainFile: main.path, bib: bibName };
  });
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
