import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runLatex } from './runner.js';

/**
 * tectonic 按需下载宏包与字体：首次用到 ctex / 中文字体 / TikZ 等时会很慢（几十秒）。
 * 服务启动后在后台编译一份覆盖常用宏包的文档，提前把它们下载进缓存，用户的第一次编译就不必等待。
 * 仅对 local-tectonic 执行器有意义（latexmk / docker 使用本地完整 TeX Live）。
 */
const WARMUP_TEX = String.raw`\documentclass[UTF8,fontset=fandol]{ctexart}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,amsthm,mathtools,bm}
\usepackage{graphicx,xcolor,booktabs,multirow,array,tabularx,subcaption,float}
\usepackage{enumitem,url,cite}
\usepackage{algorithm,algorithmic}
\usepackage{tikz,pgfplots}
\pgfplotsset{compat=1.17}
\usepackage[hidelinks]{hyperref}
\usepackage{cleveref}
\begin{document}
\title{预热 Warmup}\author{TeXdraft}\maketitle
\tableofcontents
\section{中文 English}
正文\textbf{粗体}\textit{斜体}\texttt{等宽}，{\kaishu 楷体}{\heiti 黑体}{\fangsong 仿宋}。
Some English text with $\alpha+\beta=\gamma$ and \[ \sum_{i=1}^n \bm{x}_i^\top \mathbf{W} \]
\begin{table}[h]\centering\begin{tabular}{lcc}\toprule A & B & C\\\midrule 1 & 2 & 3\\\bottomrule\end{tabular}\caption{表}\end{table}
\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}
\begin{algorithm}\caption{A}\begin{algorithmic}\STATE x\end{algorithmic}\end{algorithm}
\end{document}
`;

export async function warmupTectonic() {
  if (config.compile.runner !== 'local-tectonic') return;
  const root = path.join(config.dataDir, 'compile', '_warmup');
  const src = path.join(root, 'src');
  const marker = path.join(root, 'done-v1');
  if (await fs.stat(marker).then(() => true, () => false)) return;
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'main.tex'), WARMUP_TEX);
  const started = Date.now();
  const r = await runLatex({ srcDir: src, outDir: path.join(root, 'out'), mainFile: 'main.tex', engine: 'xelatex', timeoutMs: 15 * 60 * 1000 });
  const ok = r.exitCode === 0 || /Writing .*main\.pdf/.test(r.output);
  console.log(`[compile] tectonic warmup ${ok ? 'finished' : 'failed'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (ok) await fs.writeFile(marker, new Date().toISOString());
}
