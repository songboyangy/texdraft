// Overleaf LaTeX 语言模块接入测试：语法树、大纲、数学模式判断、语法检查（直接调用 worker 中的 Parse）
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
// latex-linter.ts 在加载时创建 Web Worker；Node 中没有 Worker，先放一个空实现（检查逻辑本身直接调用 Parse 测试）
(globalThis as any).Worker ??= class { addEventListener() {} postMessage() {} };
const { extractOutline, isInMath, latexLanguage } = await import('../src/lib/latexLanguage');
const { default: LintWorker } = await import('../src/lib/overleaf/features/source-editor/languages/latex/linter/latex-linter.worker');

let fail = 0;
const ok = (c: boolean, m: string, extra = '') => { console.log(c ? 'ok  ' : 'FAIL', m, c ? '' : extra); if (!c) fail++; };

const doc = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}
Text with inline math $E = mc^2$ and a \cite{smith2020}.
\subsection{Background}
\begin{equation}
  a^2 + b^2 = c^2 \label{eq:pyth}
\end{equation}
\section*{Related Work}
More text.
\end{document}
`;
const state = EditorState.create({ doc, extensions: [latexLanguage()] });
const tree = syntaxTree(state);
const names = new Set<string>();
tree.iterate({ enter: (n) => { names.add(n.type.name); } });
ok(['DocumentClass', 'UsePackage', 'SectioningCommand', 'EquationEnvironment', 'Cite'].every((n) => names.has(n)) || names.has('$Environment'),
  'parser builds a LaTeX syntax tree', [...names].slice(0, 30).join(' '));

const outline = extractOutline(state);
ok(JSON.stringify(outline.map((o) => [o.title, o.line])) === JSON.stringify([['Introduction', 4], ['Background', 6], ['Related Work', 10]]),
  'outline lists sections with line numbers', JSON.stringify(outline));
ok(outline[1].level > outline[0].level, 'subsection is nested deeper than section');

ok(isInMath(state, doc.indexOf('mc^2')), 'cursor inside $...$ is math');
ok(isInMath(state, doc.indexOf('b^2')), 'cursor inside equation environment is math');
ok(!isInMath(state, doc.indexOf('More text')), 'normal text is not math');

const lint = new LintWorker();
const bad = String.raw`\begin{itemize}
\item one
\end{enumerate}
Unclosed brace {here
`;
const errs = lint.Parse(bad).errors.map((e: any) => e.text);
ok(errs.some((t: string) => /enumerate|itemize|end/i.test(t)), 'linter flags mismatched \\begin/\\end', JSON.stringify(errs));
ok(lint.Parse(doc).errors.filter((e: any) => e.type === 'error').length === 0, 'linter is clean on a valid document', JSON.stringify(lint.Parse(doc).errors));
process.exit(fail ? 1 : 0);
