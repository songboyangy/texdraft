// 字数统计（Overleaf 客户端统计逻辑）：跨 \input 文件、标题/图题/脚注分类、中文分词
(globalThis as any).Worker ??= class { addEventListener() {} postMessage() {} };
const { countProjectWords } = await import('../src/lib/wordCount');

let fail = 0;
const ok = (c: boolean, m: string, extra = '') => { console.log(c ? 'ok  ' : 'FAIL', m, c ? '' : extra); if (!c) fail++; };

const texts = [
  { path: 'main.tex', content: String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}
This paper has five words. $x^2$
\input{sections/zh}
\begin{figure}\caption{A short caption}\end{figure}
Text with a footnote\footnote{Note here}.
\[ E = mc^2 \]
\end{document}
` },
  { path: 'sections/zh.tex', content: '我们提出了一种新的方法。\n' },
];
const d = countProjectWords(texts, 'main.tex', 'zh-CN');
ok(d.headWords === 1 && d.headers === 1, 'section heading counted separately', JSON.stringify({ headWords: d.headWords, headers: d.headers }));
ok(d.captionWords === 3, 'caption words counted', String(d.captionWords));
ok(d.footnoteWords === 2, 'footnote words counted', String(d.footnoteWords));
ok(d.mathInline === 1 && d.mathDisplay === 1, 'inline and display math counted', JSON.stringify({ i: d.mathInline, d: d.mathDisplay }));
ok(d.textWords >= 5 + 3 + 3, 'body words include English and segmented Chinese from the \\input file', String(d.textWords));
ok(d.textCharacters >= 11, 'Chinese characters counted', String(d.textCharacters));
ok(countProjectWords(texts, 'missing.tex').textWords === 0, 'missing main file yields zero instead of throwing');
process.exit(fail ? 1 : 0);
