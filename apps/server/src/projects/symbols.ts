import type { ProjectSymbols } from '@texdraft/shared';
import { readText } from '../collab/hocuspocus.js';
import { listFiles } from './service.js';

/** 扫描项目，提取补全所需的符号：\label、BibTeX 键、自定义命令、文件路径 */
export async function projectSymbols(projectId: string): Promise<ProjectSymbols> {
  const files = await listFiles(projectId);
  const out: ProjectSymbols = { labels: [], citations: [], commands: [], files: files.map((f) => f.path) };
  const commands = new Set<string>();

  for (const f of files) {
    if (f.kind !== 'text') continue;
    const text = await readText(f.id);
    if (f.path.endsWith('.bib')) {
      // @article{key, ... title = {...}
      const re = /@(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (/^(comment|string|preamble)$/i.test(m[1])) continue;
        const title = /\btitle\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n/i.exec(m[3])?.[1]?.replace(/[{}\s]+/g, ' ').trim();
        const author = /\bauthor\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n/i.exec(m[3])?.[1]?.replace(/[{}\s]+/g, ' ').trim();
        out.citations.push({ key: m[2], title, author, type: m[1].toLowerCase() });
      }
      continue;
    }
    if (!/\.(tex|sty|cls|ltx)$/.test(f.path)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/(^|[^\\])%.*$/, '$1'); // 去掉注释
      for (const m of code.matchAll(/\\label\{([^}]+)\}/g)) {
        out.labels.push({ label: m[1], file: f.path, line: i + 1, context: line.trim().slice(0, 80) });
      }
      for (const m of code.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?|\\(?:DeclareMathOperator|DeclareRobustCommand|providecommand)\*?\s*\{?\\([A-Za-z@]+)\}?|\\def\\([A-Za-z@]+)/g)) {
        commands.add(m[1] || m[2] || m[3]);
      }
      // \bibitem{key}
      for (const m of code.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) out.citations.push({ key: m[1], type: 'bibitem' });
    });
  }
  out.commands = [...commands].sort();
  return out;
}
