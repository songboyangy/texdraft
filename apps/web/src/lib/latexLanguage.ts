import { HighlightStyle, LanguageSupport, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import type { EditorState, Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { LaTeXLanguage } from './overleaf/features/source-editor/languages/latex/latex-language';
import { latexLinter } from './overleaf/features/source-editor/languages/latex/linter/latex-linter';
import { enterNode, type FlatOutlineItem } from './overleaf/features/source-editor/utils/tree-operations/outline';
import { mathAncestorNode } from './overleaf/features/source-editor/utils/tree-operations/math';

/**
 * TeXdraft 对 Overleaf LaTeX 语言模块的接入层：
 *  - Lezer 语法树驱动的高亮与折叠（LaTeXLanguage）
 *  - Web Worker 中运行的实时语法检查（环境不匹配、括号不配对等）
 *  - 文档大纲提取、数学模式判断
 */

/** 配色参考 Overleaf 默认的浅色编辑器主题 */
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: '#1b5fbd' }, // \command
  { tag: t.keyword, color: '#7a3e9d', fontWeight: '500' }, // \documentclass \usepackage \cite \ref \label
  { tag: t.literal, color: '#1b5fbd' }, // 控制符 \\ \{ 等
  { tag: t.attributeValue, color: '#0a7e6e' }, // 环境名、标签键、文件路径
  { tag: t.typeName, color: '#a5560b' },
  { tag: t.string, color: '#8a2b2b' }, // 数学公式
  { tag: t.comment, color: '#7d8590', fontStyle: 'italic' },
  { tag: t.number, color: '#a5560b' },
  { tag: [t.brace, t.squareBracket], color: '#57606a' },
  { tag: t.link, color: '#1b5fbd', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'ui-monospace, monospace' },
  { tag: t.strong, fontWeight: '600' },
]);

export function latexLanguage(): Extension {
  return [
    new LanguageSupport(LaTeXLanguage),
    syntaxHighlighting(latexHighlight),
    linter(latexLinter, { delay: 600 }),
    lintGutter(),
  ];
}

export interface OutlineEntry {
  level: number;
  title: string;
  line: number;
}

/** 从语法树提取大纲（章节、beamer frame） */
export function extractOutline(state: EditorState, timeoutMs = 200): OutlineEntry[] {
  const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
  const items: FlatOutlineItem[] = [];
  tree.iterate({
    enter: (node) => enterNode(state, node, items, () => true),
  });
  return items.map((i) => ({ level: i.level, title: i.title.trim(), line: i.line }));
}

/** 光标是否位于数学环境中（$…$、\[…\]、equation、align 等） */
export function isInMath(state: EditorState, pos: number): boolean {
  return !!mathAncestorNode(state, pos);
}
