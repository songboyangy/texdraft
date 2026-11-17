import {
  autocompletion, clearSnippet, snippet, startCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import { Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ProjectSymbols } from '@texdraft/shared';
import { bibliographyStyles } from './overleaf/features/source-editor/languages/latex/completions/data/bibliography-styles';
import { classNames } from './overleaf/features/source-editor/languages/latex/completions/data/class-names';
import { environments, snippet as envSnippetTemplate } from './overleaf/features/source-editor/languages/latex/completions/data/environments';
import { packageNames } from './overleaf/features/source-editor/languages/latex/completions/data/package-names';
import topHundredSnippets from './overleaf/features/source-editor/languages/latex/completions/data/top-hundred-snippets';
import { mathAncestorNode } from './overleaf/features/source-editor/utils/tree-operations/math';

/**
 * LaTeX 自动补全，行为与数据对齐 Overleaf（数据见 ./overleaf-data，AGPL-3.0）：
 *  - 命令候选来自 Overleaf 的高频命令表，按使用频率分数排序（\b → \begin{} 排第一）
 *  - 环境以 “\begin{figure} …” 的形式出现在候选里，输入 \begin{f 即可选中并展开整个环境
 *  - \ref{ \cite{ \input{ \includegraphics{ \usepackage{ \documentclass{ \bibliographystyle{ 内补全对应参数
 *  - 手写 \begin{xxx} 输入右括号时自动补上 \end{xxx}
 */

/** Overleaf 片段使用 Ace 的 $1 格式，转换为 CodeMirror 的 #{1}；末尾追加一个停靠点便于 Shift-Tab 回退 */
export const prepareSnippetTemplate = (template: string) => template.replace(/\$(\d+)/g, '#{$1}') + '${}';

/** 若光标后紧跟一个未配对的右括号（closeBrackets 自动插入的），把它纳入替换范围 */
function extendOverUnpairedClosingBrace(state: EditorState, from: number, to: number) {
  if (state.sliceDoc(to, to + 1) !== '}') return to;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = /^[^\\]*/.exec(state.sliceDoc(to, line.to))?.[0] ?? '';
  const open = (before.match(/\{/g) ?? []).length - (before.match(/}/g) ?? []).length;
  const closed = (after.match(/}/g) ?? []).length - (after.match(/\{/g) ?? []).length;
  return open - closed < 0 ? to + 1 : to;
}

type Apply = (view: EditorView, completion: Completion, from: number, to: number) => void;

/** 应用片段；reopen 为 true 时插入后立即弹出参数补全（如 \cite{ 之后列出文献） */
function applySnippet(template: string, opts: { clear?: boolean; reopen?: boolean } = {}): Apply {
  return (view, completion, from, to) => {
    snippet(prepareSnippetTemplate(template))(view, completion, from, extendOverUnpairedClosingBrace(view.state, from, to));
    if (opts.clear) clearSnippet(view);
    if (opts.reopen) setTimeout(() => startCompletion(view), 0);
  };
}

/** 插入后需要立即弹出参数补全的命令 */
const REOPEN = /^\\(begin|end|cite|citep|citet|parencite|textcite|ref|eqref|autoref|cref|Cref|pageref|input|include|includegraphics|usepackage|documentclass|bibliographystyle|bibliography)(\[\])?\{/;

// ---------------- 命令（Overleaf 高频命令表 + 补充） ----------------

const overleafCommands: Completion[] = topHundredSnippets.map((item) => ({
  label: item.caption,
  type: item.meta === 'env' ? 'keyword' : 'function',
  boost: item.score,
  apply: item.snippet === item.caption ? undefined : applySnippet(item.snippet, { reopen: REOPEN.test(item.caption) }),
}));

/** Overleaf 高频表之外、论文中仍常用的命令（分数低于高频表） */
const EXTRA: [string, string?][] = [
  ['eqref', '{$1}'], ['autoref', '{$1}'], ['cref', '{$1}'], ['Cref', '{$1}'], ['pageref', '{$1}'], ['citep', '{$1}'],
  ['citet', '{$1}'], ['parencite', '{$1}'], ['textcite', '{$1}'], ['url', '{$1}'], ['href', '{$1}{$2}'],
  ['underline', '{$1}'], ['textrm', '{$1}'], ['textsf', '{$1}'], ['textcolor', '{$1}{$2}'], ['mathbb', '{$1}'],
  ['mathit', '{$1}'], ['operatorname', '{$1}'], ['dfrac', '{$1}{$2}'], ['tfrac', '{$1}{$2}'], ['prod'], ['int'], ['lim'],
  ['tilde', '{$1}'], ['widetilde', '{$1}'], ['widehat', '{$1}'], ['bar', '{$1}'], ['vec', '{$1}'], ['dot', '{$1}'],
  ['overline', '{$1}'], ['underbrace', '{$1}'], ['DeclareMathOperator', '{$1}{$2}'], ['toprule'], ['midrule'],
  ['bottomrule'], ['multirow', '{$1}{$2}{$3}'], ['addbibresource', '{$1}'], ['printbibliography'], ['tableofcontents'],
  ['today'], ['thanks', '{$1}'], ['noindent'], ['vfill'], ['qquad'], ['ldots'], ['cdots'], ['vdots'], ['ddots'], ['pm'],
  ['approx'], ['sim'], ['equiv'], ['propto'], ['neq'], ['geq'], ['notin'], ['subset'], ['subseteq'], ['cup'], ['cap'],
  ['setminus'], ['emptyset'], ['forall'], ['exists'], ['rightarrow'], ['Rightarrow'], ['leftarrow'], ['Leftrightarrow'],
  ['mapsto'], ['to'], ['mid'], ['top'], ['perp'], ['circ'], ['ell'], ['nabla'], ['langle'], ['rangle'], ['log'], ['ln'],
  ['exp'], ['sin'], ['cos'], ['tan'], ['max'], ['min'], ['arg'], ['sup'], ['inf'], ['det'], ['columnwidth'], ['tiny'],
  ['normalsize'], ['newline'], ['appendix'], ['phantom', '{$1}'], ['mbox', '{$1}'], ['textup', '{$1}'],
];
const extraCommands: Completion[] = EXTRA.map(([name, args]) => {
  const caption = `\\${name}${(args ?? '').replace(/\$\d+/g, '')}`;
  return {
    label: caption,
    type: 'function',
    boost: 0.01,
    apply: args ? applySnippet(`\\${name}${args}`, { reopen: REOPEN.test(caption) }) : undefined,
  };
});

/** 环境：以 “\begin{figure} …” 的形式作为候选，选中后展开整个环境（与 Overleaf 一致） */
const CLEAR_ENVS = new Set(['abstract', 'itemize', 'enumerate']);
const EXTRA_ENVS = [
  'figure*', 'table*', 'cases', 'theorem', 'lemma', 'definition', 'corollary', 'proposition', 'remark', 'example',
  'algorithm', 'algorithmic', 'minipage', 'subfigure', 'quotation', 'lstlisting', 'matrix', 'pmatrix', 'bmatrix',
  'tikzpicture', 'thebibliography', 'flushleft', 'flushright',
];
const environmentCompletions: Completion[] = [
  ...[...environments].map(([env, tpl]) => ({
    label: `\\begin{${env}} …`,
    type: 'class',
    apply: applySnippet(tpl, { clear: CLEAR_ENVS.has(env) }),
  })),
  ...EXTRA_ENVS.filter((e) => !environments.has(e)).map((env) => ({
    label: `\\begin{${env}} …`,
    type: 'class',
    apply: applySnippet(envSnippetTemplate(env)),
  })),
];

const COMMAND_OPTIONS = (() => {
  const seen = new Set<string>();
  return [...overleafCommands, ...extraCommands].filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)));
})();

/** 只在数学模式中有意义的命令：数学模式里排前，正文里排后（仍可选） */
const MATH_ONLY = new RegExp(
  '^\\\\(' +
    [
      'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega',
      'Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega',
      'frac|dfrac|tfrac|sqrt|sum|prod|int|iint|oint|lim|left|right|mathbf|mathcal|mathbb|mathrm|mathit|boldsymbol|operatorname',
      'hat|bar|tilde|widetilde|widehat|vec|dot|ddot|overline|underbrace|overbrace|cdot|cdots|vdots|ddots|ldots|times|div|pm|mp',
      'infty|partial|nabla|leq|geq|neq|approx|sim|simeq|equiv|propto|in|notin|subset|subseteq|supset|cup|cap|setminus|emptyset',
      'forall|exists|neg|land|lor|rightarrow|Rightarrow|leftarrow|Leftarrow|leftrightarrow|Leftrightarrow|mapsto|to|mid|top|perp|circ|ell|langle|rangle',
      'log|ln|exp|sin|cos|tan|max|min|arg|sup|inf|det',
    ].join('|') +
    ')(\\{|\\[|$)',
);

function adjustForMode(options: readonly Completion[], inMath: boolean): Completion[] {
  return options.map((o) => {
    if (!MATH_ONLY.test(o.label)) return o;
    return { ...o, boost: (o.boost ?? 0) + (inMath ? 5 : -3) };
  });
}

// ---------------- 参数补全 ----------------

const REF_CMDS = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\{([^}]*)$/;
const CITE_CMDS = /\\(?:cite[tp]?\*?|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite)(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const FILE_CMDS = /\\(input|include|includegraphics(?:\[[^\]]*\])?|bibliography|addbibresource|subfile|lstinputlisting)\{([^}]*)$/;
const PKG_CMD = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)$/;
const CLASS_CMD = /\\documentclass(?:\[[^\]]*\])?\{([^}]*)$/;
const BIBSTYLE_CMD = /\\bibliographystyle\{([^}]*)$/;
const BEGIN_ARG = /\\begin\{([^}]*)$/;
const END_ARG = /\\end\{([^}]*)$/;

/** 光标之前尚未闭合的环境（由内到外） */
function openEnvironments(textBefore: string): string[] {
  const stack: string[] = [];
  for (const m of textBefore.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else {
      const i = stack.lastIndexOf(m[2]);
      if (i >= 0) stack.splice(i, 1);
    }
  }
  return stack.reverse();
}

export function latexCompletion(getSymbols: () => Promise<ProjectSymbols | null>): Extension {
  return [
    autocompletion({
      activateOnTyping: true,
      icons: false,
      override: [(ctx) => complete(ctx, getSymbols)],
    }),
    autoCloseEnvironment,
  ];
}

export async function complete(
  ctx: CompletionContext,
  getSymbols: () => Promise<ProjectSymbols | null>,
): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  let m: RegExpExecArray | null;

  // \begin{…：候选为 “\begin{figure} …” 等完整环境（替换范围从 \begin 开始），外加按已输入名字生成的自定义环境
  if ((m = BEGIN_ARG.exec(before))) {
    const typed = m[1];
    const from = ctx.pos - typed.length - '\\begin{'.length;
    const options = [...environmentCompletions];
    if (typed && !options.some((o) => o.label === `\\begin{${typed}} …`)) {
      options.push({ label: `\\begin{${typed}} …`, type: 'class', boost: -1, apply: applySnippet(envSnippetTemplate(typed)) });
    }
    return { from, options, validFor: /^\\begin\{[^}\s]*$/ };
  }
  // \end{…：只给出当前未闭合的环境，越内层越靠前
  if ((m = END_ARG.exec(before))) {
    const open = openEnvironments(ctx.state.sliceDoc(0, ctx.pos - m[1].length - '\\end{'.length));
    if (!open.length) return null;
    return {
      from: ctx.pos - m[1].length,
      options: open.map((env, i) => ({ label: env, type: 'class', boost: 50 - i })),
      validFor: /^[^}\s]*$/,
    };
  }
  if ((m = REF_CMDS.exec(before))) {
    const s = await getSymbols();
    return arg(ctx, m[1], s?.labels.map((l) => ({ label: l.label, detail: `${l.file}:${l.line}`, info: l.context, type: 'variable' })) ?? []);
  }
  if ((m = CITE_CMDS.exec(before))) {
    const s = await getSymbols();
    return arg(ctx, m[1], s?.citations.map((c) => ({
      label: c.key,
      type: 'constant',
      detail: c.title ? truncate(c.title, 40) : c.type,
      info: [c.title, c.author].filter(Boolean).join('\n') || undefined,
    })) ?? []);
  }
  if ((m = PKG_CMD.exec(before))) {
    return arg(ctx, m[1], packageNames.map((p) => ({ label: p, type: 'module' })));
  }
  if ((m = CLASS_CMD.exec(before))) {
    return arg(ctx, m[1], classNames.map((c) => ({ label: c, type: 'module' })), true);
  }
  if ((m = BIBSTYLE_CMD.exec(before))) {
    return arg(ctx, m[1], Object.values(bibliographyStyles).flat().map((b) => ({ label: b, type: 'module' })), true);
  }
  if ((m = FILE_CMDS.exec(before))) {
    const s = await getSymbols();
    const cmd = m[1];
    const files = s?.files ?? [];
    const opts = cmd.startsWith('includegraphics')
      ? files.filter((f) => /\.(png|jpe?g|pdf|eps|svg|gif)$/i.test(f)).map((f) => ({ label: f, type: 'text' }))
      : cmd === 'bibliography' || cmd === 'addbibresource'
        ? files.filter((f) => f.endsWith('.bib')).map((f) => ({ label: cmd === 'bibliography' ? f.replace(/\.bib$/, '') : f, type: 'text' }))
        : files.filter((f) => f.endsWith('.tex')).map((f) => ({ label: f.replace(/\.tex$/, ''), type: 'text' }));
    return arg(ctx, m[2], opts, true);
  }

  // 命令：\xxx（环境候选 “\begin{xx} …” 也在其中，与 Overleaf 一致）
  const word = ctx.matchBefore(/\\[A-Za-z@*]*$/);
  if (!word) return null;
  const s = await getSymbols();
  const known = new Set(COMMAND_OPTIONS.map((o) => o.label.replace(/[[{].*$/, '')));
  const custom: Completion[] = (s?.commands ?? [])
    .filter((c) => !known.has('\\' + c))
    .map((c) => ({ label: '\\' + c, type: 'function', detail: '自定义', boost: 1 }));
  const inMath = !!mathAncestorNode(ctx.state, ctx.pos);
  return {
    from: word.from,
    options: [...adjustForMode(COMMAND_OPTIONS, inMath), ...(inMath ? [] : environmentCompletions), ...custom],
    validFor: /^\\[A-Za-z@*]*$/,
  };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 补全花括号内的参数；多个键用逗号分隔时只替换最后一个 */
function arg(ctx: CompletionContext, typed: string, options: Completion[], single = false): CompletionResult | null {
  const lastPart = single ? typed : typed.split(',').pop()!.trimStart();
  const seen = new Set<string>();
  const unique = options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true)));
  if (!unique.length) return null;
  return { from: ctx.pos - lastPart.length, options: unique, validFor: single ? /^[^}]*$/ : /^[^},\s]*$/ };
}

/**
 * 手写 \begin{xxx} 并输入右括号时，自动补上 \end{xxx}，光标放在中间。
 * 只在该行后面没有其他内容、且文档中该环境的 \end 数量不足时触发。
 */
export function autoCloseSpec(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  if (text !== '}' || from !== to) return null;
  const line = state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const m = /\\begin\{([A-Za-z@*]+)$/.exec(before);
  if (!m) return null;
  const env = m[1];
  const nextIsBrace = state.sliceDoc(from, from + 1) === '}';
  const restOfLine = line.text.slice(from - line.from + (nextIsBrace ? 1 : 0));
  if (restOfLine.trim()) return null;

  const doc = state.doc.toString().replace(/(^|[^\\])%.*$/gm, '$1');
  const esc = env.replace(/[*]/g, '\\*');
  const begins = (doc.match(new RegExp(`\\\\begin\\{${esc}\\}`, 'g')) ?? []).length + (nextIsBrace ? 0 : 1);
  const ends = (doc.match(new RegExp(`\\\\end\\{${esc}\\}`, 'g')) ?? []).length;
  if (ends >= begins) return null;

  const indent = /^\s*/.exec(line.text)![0];
  const inner = indent + '  ';
  return {
    changes: { from, to: nextIsBrace ? from + 1 : from, insert: `}\n${inner}\n${indent}\\end{${env}}` },
    selection: { anchor: from + 2 + inner.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  };
}

// 必须高于 basicSetup 中 closeBrackets 的优先级，否则光标后已有 } 时它会先“跳过”右括号
const autoCloseEnvironment = Prec.high(
  EditorView.inputHandler.of((view, from, to, text) => {
    const spec = autoCloseSpec(view.state, from, to, text);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  }),
);
