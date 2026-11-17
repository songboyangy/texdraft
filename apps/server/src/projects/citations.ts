import type { CitationSearchResult } from '@texdraft/shared';
import { readText, transactText } from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { badRequest } from '../lib/http.js';
import { createTextFile, listFiles } from './service.js';

/**
 * 文献检索与 BibTeX 管理：
 *  - 在线检索 Crossref（带 DOI 的期刊/会议论文）与 arXiv（预印本），无需 API Key
 *  - 获取 BibTeX：Crossref 用其官方转换接口；arXiv 根据元数据生成
 *  - 统一生成 Google Scholar 风格的键（vaswani2017attention），追加到项目 .bib，按 DOI / arXiv 号去重
 */

const UA = 'TeXdraft/0.1 (open-source LaTeX editor; https://github.com/)';
const TIMEOUT = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

interface CrossrefItem {
  DOI: string;
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  type?: string;
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
    }));
}

async function searchCrossref(query: string, rows: number): Promise<CitationSearchResult[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,issued,container-title,type`;
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

async function arxivQuery(params: string) {
  const res = await fetchWithTimeout(`https://export.arxiv.org/api/query?${params}`);
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  return parseArxivFeed(await res.text());
}

async function searchArxiv(query: string, max: number): Promise<CitationSearchResult[]> {
  // 形如 2301.12345 的编号直接按 id 查
  const idMatch = ARXIV_ID.exec(query.trim());
  if (idMatch) return arxivQuery(`id_list=${idMatch[1]}`);
  // 两路并行：标题短语匹配（论文名检索最准）+ 所有词都出现（关键词检索）
  const words = query.replace(/["():]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  const phrase = `ti:"${words.join(' ')}"`;
  const allTerms = words.map((w) => `all:${w}`).join(' AND ');
  const q = (sq: string, n: number) => `search_query=${encodeURIComponent(sq)}&start=0&max_results=${n}&sortBy=relevance`;
  const [a, b] = await Promise.allSettled([arxivQuery(q(phrase, 5)), arxivQuery(q(allTerms, max))]);
  const merged = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
  if (!merged.length && a.status === 'rejected') throw a.reason;
  const seen = new Set<string>();
  return merged.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
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

/** 标题与查询的相似度：完全一致 > 覆盖查询词的比例 > 标题冗余程度；正式出版物略优先 */
export function relevance(query: string, r: CitationSearchResult) {
  const q = tokens(query);
  const t = tokens(r.title);
  if (!q.size || !t.size) return 0;
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  let score = (hit / q.size) * 0.7 + (hit / t.size) * 0.3;
  if (normTitle(r.title) === normTitle(query)) score += 1;
  if (r.source === 'crossref' && /^(journal-article|proceedings-article|book-chapter)$/.test(r.type ?? '')) score += 0.05;
  if (r.source === 'crossref' && /^(posted-content|peer-review|component|other)$/.test(r.type ?? '')) score -= 0.1;
  return score;
}

/** 并行检索两个来源；某个来源失败不影响另一个 */
export async function searchOnline(query: string) {
  const q = query.trim();
  if (q.length < 2) throw badRequest('Query too short');
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i.exec(q)?.[1];
  const arxivId = ARXIV_ID.test(q);
  // DOI → 只按 DOI 精确查 Crossref；arXiv 编号 → 只查 arXiv；其余 → 两个来源并行检索
  const [cr, ax] = await Promise.allSettled([
    doi ? crossrefByDoi(doi) : arxivId ? Promise.resolve([]) : searchCrossref(q, 10),
    doi ? Promise.resolve([]) : searchArxiv(q, 6),
  ]);
  const crossref = cr.status === 'fulfilled' ? cr.value : [];
  const arxiv = ax.status === 'fulfilled' ? ax.value : [];
  // 同一篇论文（标题相同且第一作者姓相同）同时出现在 arXiv 与正式出版物中时，保留正式出版物；
  // 再按与查询的相似度统一排序（DOI / arXiv 编号查询不重排）
  // 若 arXiv 版本比正式记录早一年以上（如后来的书籍再版），保留更早的 arXiv 版本，避免年份错误
  const arxivById = new Map(arxiv.map((r) => [identity(r), r]));
  const keptCrossref = crossref.filter((c) => {
    const a = arxivById.get(identity(c));
    return !(a && a.year && c.year && a.year < c.year - 1);
  });
  const seen = new Set(keptCrossref.map(identity));
  const merged = [...keptCrossref, ...arxiv.filter((r) => !seen.has(identity(r)))];
  if (doi || arxivId) return { results: merged, errors: [] as string[] };
  const results = merged
    .map((r, i) => ({ r, i, s: relevance(q, r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
    .slice(0, 14);
  const errors = [cr, ax].filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
  return { results, errors };
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
  const dupKey =
    (r.source === 'crossref' && index.byId.get(`doi:${r.id.toLowerCase()}`)) ||
    (r.source === 'arxiv' && (index.byId.get(`arxiv:${r.id.toLowerCase()}`) || (r.doi && index.byId.get(`doi:${r.doi.toLowerCase()}`))));
  const target = index.bibs[0];
  if (dupKey) {
    return { key: dupKey, bibPath: target?.path ?? '', added: false, needsBibliography: !(await hasBibliographyCommand(projectId)) };
  }

  const entry = r.source === 'crossref' ? await crossrefBibtex(r.id) : arxivBibtex(r);
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
