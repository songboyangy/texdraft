import type { SearchMatch, SearchQuery } from '@texdraft/shared';
import { readText, transactText } from '../collab/hocuspocus.js';
import { badRequest } from '../lib/http.js';
import { listFiles } from './service.js';

const MAX_RESULTS = 1000;

function buildRegex(q: SearchQuery): RegExp {
  if (!q.query) throw badRequest('Empty query');
  let source = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${q.caseSensitive ? '' : 'i'}`);
  } catch (e) {
    throw badRequest(`Invalid regular expression: ${(e as Error).message}`);
  }
}

/** 全项目文本搜索（只搜文本文件，读取的是实时协作文档） */
export async function searchProject(projectId: string, q: SearchQuery) {
  const re = buildRegex(q);
  const results: SearchMatch[] = [];
  let truncated = false;
  for (const f of await listFiles(projectId)) {
    if (f.kind !== 'text') continue;
    const lines = (await readText(f.id)).split('\n');
    for (let i = 0; i < lines.length && !truncated; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (m[0].length === 0) continue;
        const col = m.index!;
        const start = Math.max(0, col - 40);
        results.push({
          path: f.path,
          line: i + 1,
          column: col + 1,
          length: m[0].length,
          preview: (start > 0 ? '…' : '') + line.slice(start, col + m[0].length + 80),
          previewOffset: col - start + (start > 0 ? 1 : 0),
        });
        if (results.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }
  return { results, truncated };
}

/** 全项目替换：每个文件一次 Yjs 事务，在线协作者实时可见 */
export async function replaceInProject(projectId: string, q: SearchQuery & { replacement: string; paths?: string[] }) {
  const re = buildRegex(q);
  let replaced = 0;
  let files = 0;
  for (const f of await listFiles(projectId)) {
    if (f.kind !== 'text' || (q.paths && !q.paths.includes(f.path))) continue;
    const n = await transactText(f.id, 'replace-all', (ytext) => {
      const text = ytext.toString();
      const matches = [...text.matchAll(re)].filter((m) => m[0].length > 0);
      // 从后往前替换，前面的位置不受影响
      for (const m of matches.reverse()) {
        const replacement = q.regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), q.replacement) : q.replacement;
        ytext.delete(m.index!, m[0].length);
        ytext.insert(m.index!, replacement);
      }
      return matches.length;
    });
    if (n > 0) {
      replaced += n;
      files++;
    }
  }
  return { replaced, files };
}

/** 所有文本文件的内容（字数统计等前端分析用） */
export async function projectTexts(projectId: string) {
  const out: { path: string; content: string }[] = [];
  for (const f of await listFiles(projectId)) {
    if (f.kind === 'text') out.push({ path: f.path, content: await readText(f.id) });
  }
  return out;
}
