import type { CompileDiagnostic } from '@texdraft/shared';

/**
 * 解析 TeX 日志，产出结构化诊断（错误 / 警告 / 盒子溢出）。
 * 用括号栈追踪“当前正在读的文件”，再把文件名映射回项目内路径。
 * 兼容 -file-line-error 格式（latexmk）与经典 "! ..." + "l.N" 格式（tectonic）。
 */
export function parseTexLog(log: string, projectPaths: string[]): CompileDiagnostic[] {
  const known = new Set(projectPaths);
  const resolve = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    let p = raw.trim().replace(/^"|"$/g, '');
    p = p.replace(/^(\.\/)+/, '');
    // 绝对路径（如 /work/src/sections/a.tex）：取能匹配上项目文件的最长后缀
    if (p.startsWith('/')) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) {
        const cand = segs.slice(i).join('/');
        if (known.has(cand) || known.has(cand + '.tex')) { p = cand; break; }
      }
    }
    if (known.has(p)) return p;
    if (known.has(p + '.tex')) return p + '.tex';
    return undefined;
  };

  const out: CompileDiagnostic[] = [];
  const stack: (string | null)[] = [];
  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
    return null;
  };

  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- -file-line-error 风格：./sections/a.tex:12: Undefined control sequence.
    const fle = /^(\.{0,2}\/?[^\s:()][^:()]*?):(\d+): (.*)$/.exec(line);
    if (fle && /\.(tex|sty|cls|bib|ltx)$|\//.test(fle[1])) {
      out.push({ level: 'error', file: resolve(fle[1]), line: Number(fle[2]), message: collectMessage(fle[3], lines, i) });
      continue;
    }

    // ---- 经典错误：! Undefined control sequence.  ... l.12 \foo
    if (line.startsWith('! ')) {
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
        const m = /^l\.(\d+)/.exec(lines[j]);
        if (m) { lineNo = Number(m[1]); break; }
        if (lines[j].startsWith('! ')) break;
      }
      out.push({ level: 'error', file: resolve(currentFile()), line: lineNo, message: collectMessage(line.slice(2), lines, i) });
      continue;
    }

    // ---- LaTeX / Package / Class 警告（可能跨行，续行以 "(pkg)" 开头）
    const warn = /^(LaTeX|Package (\S+)|Class (\S+)|LaTeX Font) Warning: (.*)$/.exec(line);
    if (warn) {
      if (warn[1] === 'LaTeX Font') continue; // 字体替换警告太多，忽略
      let msg = warn[4];
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j]); j++) {
        msg += ' ' + lines[j].replace(/^\(\S+\)\s+/, '');
      }
      const lm = /on input line (\d+)\.?/.exec(msg);
      const pkg = warn[2] || warn[3];
      out.push({
        level: 'warning',
        file: resolve(currentFile()),
        line: lm ? Number(lm[1]) : undefined,
        message: (pkg ? `[${pkg}] ` : '') + msg.replace(/\s+/g, ' ').trim(),
      });
      continue;
    }

    // ---- Overfull / Underfull 盒子
    const box = /^(Overfull|Underfull) \\[hv]box .*?(?:at lines? (\d+)(?:--\d+)?|detected at line (\d+))?$/.exec(line);
    if (box && /^(Overfull|Underfull)/.test(line)) {
      const ln = box[2] || box[3];
      out.push({ level: 'badbox', file: resolve(currentFile()), line: ln ? Number(ln) : undefined, message: line.trim() });
      continue;
    }

    // ---- 括号栈：追踪当前文件
    trackParens(line, stack);
  }

  return dedupe(out);
}

function collectMessage(first: string, lines: string[], i: number): string {
  // LaTeX Error 常跨多行（如 "See the LaTeX manual..." 之前的部分）
  let msg = first.trim();
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    const l = lines[j];
    if (!l.trim() || l.startsWith('l.') || l.startsWith('See the ') || l.startsWith('Type ') || l.startsWith('!')) break;
    if (/^\S.*[^.]$/.test(msg) && !/^[({\\]/.test(l)) msg += ' ' + l.trim();
    else break;
  }
  return msg.length > 400 ? msg.slice(0, 400) + '…' : msg;
}

const FILE_TOKEN = /^\(("?)((?:\.{0,2}\/)?[\w\-.+/]+(?:\.\w+)?)\1/;

function trackParens(line: string, stack: (string | null)[]) {
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === '(') {
      const m = FILE_TOKEN.exec(line.slice(k));
      if (m && (m[2].includes('.') || m[2].includes('/'))) {
        stack.push(m[2]);
        k += m[0].length - 1;
      } else {
        stack.push(null);
      }
    } else if (ch === ')') {
      stack.pop();
    }
  }
}

function dedupe(items: CompileDiagnostic[]): CompileDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((d) => {
    const k = `${d.level}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** tectonic 在致命错误时可能没有 .log，只在 stdout 打印 "error: file:line: msg" */
export function parseTectonicStdout(stdout: string, projectPaths: string[]): CompileDiagnostic[] {
  const known = new Set(projectPaths);
  const out: CompileDiagnostic[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(error|warning): (?:(.+?):(\d+): )?(.*)$/.exec(line);
    if (!m) continue;
    if (/something bad happened|unrecoverable error|errors were issued|halted on/.test(m[4])) continue;
    let file = m[2]?.replace(/^(\.\/)+/, '');
    if (file && !known.has(file) && known.has(file + '.tex')) file += '.tex';
    out.push({
      level: m[1] === 'error' ? 'error' : /Overfull|Underfull/.test(m[4]) ? 'badbox' : 'warning',
      file: file && known.has(file) ? file : undefined,
      line: m[3] ? Number(m[3]) : undefined,
      message: m[4],
    });
  }
  return dedupe(out);
}

/** 宏包 / 文档类要求特定引擎时的提示，如 aaai2027.sty 的 "pdfTeX is required to compile this document." */
const ENGINE_REQUIRED = /\b(pdfTeX|XeTeX|LuaTeX|pdfLaTeX|XeLaTeX|LuaLaTeX)\b[^\n]{0,40}\b(is )?required\b/i;

/**
 * 编译失败但日志里没有可解析的错误（宏包自己打印一段说明后直接 \end 退出等）时，
 * 从日志末尾取最后一段有意义的文字作为错误；识别出引擎要求时附上说明。
 * tectonicOnly：服务器只有 tectonic（固定 XeTeX 引擎），项目里的引擎设置不起作用。
 */
export function explainSilentFailure(log: string, opts: { tectonicOnly: boolean }): CompileDiagnostic | null {
  const tail = log.split(/\r?\n/).slice(-40);
  const text = tail
    .map((l) => l.replace(/^\s*\*+\s?/, '').replace(/\s?\*+\s*$/, '').trim())
    .filter((l) => l && !/^[()]+$/.test(l) && !/^(Package|File|Document Class): /.test(l) && !/^\\[a-zA-Z@]+=/.test(l))
    .slice(-4)
    .join(' ');
  const engine = ENGINE_REQUIRED.exec(log)?.[1];
  if (engine) {
    const wantsPdf = /^pdf/i.test(engine);
    let message = `${engine} is required by this document (a package or class checks the engine).`;
    if (wantsPdf && opts.tectonicOnly) {
      message += ' This server compiles with Tectonic, which only has the XeTeX engine, so pdfLaTeX documents cannot be compiled here. Ask the administrator to use TeX Live (COMPILE_RUNNER=local-latexmk or the Docker image).';
    } else {
      message += ` Set the compiler to ${engine.replace(/^pdftex$/i, 'pdfLaTeX').replace(/^xetex$/i, 'XeLaTeX').replace(/^luatex$/i, 'LuaLaTeX')} in the project settings.`;
    }
    return { level: 'error', message };
  }
  return text ? { level: 'error', message: `Compilation stopped without a PDF. Last lines of the log: ${text.slice(0, 400)}` } : null;
}
