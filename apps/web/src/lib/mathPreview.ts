import { StateField, type EditorState } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { descendantsOfNodeWithType } from './overleaf/features/source-editor/utils/tree-operations/ancestors';
import { mathAncestorNode, parseMathContainer } from './overleaf/features/source-editor/utils/tree-operations/math';

/**
 * 公式实时预览：光标位于公式内时，在上方浮层渲染该公式（行为参照 Overleaf 的 math-preview，
 * 渲染器用 KaTeX 代替 MathJax，体积小、同步渲染）。文档中的 \newcommand 会作为宏传给 KaTeX。
 */

function getMathContainer(state: EditorState) {
  const range = state.selection.main;
  if (!range.empty) return null;
  const ancestor = mathAncestorNode(state, range.from);
  if (!ancestor) return null;
  const [node] = descendantsOfNodeWithType(ancestor, 'Math', 'Math');
  if (!node) return null;
  return parseMathContainer(state, node, ancestor);
}

/** 从文档中收集 \newcommand / \renewcommand / \DeclareMathOperator 作为 KaTeX 宏 */
function documentMacros(state: EditorState): Record<string, string> {
  const text = state.doc.toString().replace(/(^|[^\\])%.*$/gm, '$1');
  const macros: Record<string, string> = {};
  for (const m of text.matchAll(/\\(?:re)?newcommand\*?\s*\{?(\\[A-Za-z@]+)\}?\s*(?:\[(\d)\])?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
    macros[m[1]] = m[3];
  }
  for (const m of text.matchAll(/\\DeclareMathOperator(\*?)\s*\{(\\[A-Za-z@]+)\}\s*\{([^}]*)\}/g)) {
    macros[m[2]] = `\\operatorname${m[1]}{${m[3]}}`;
  }
  return macros;
}

/** KaTeX 不支持或预览中无意义的命令 */
function cleanForPreview(content: string) {
  return content
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}/g, (_m, env) =>
      `\\begin{${env === 'equation' ? 'equation*' : env + '*'}}`)
    .replace(/\\end\{(equation|align|gather|multline|flalign|alignat)(\*?)\}/g, (_m, env) =>
      `\\end{${env === 'equation' ? 'equation*' : env + '*'}}`);
}

function buildTooltip(state: EditorState): Tooltip | null {
  const container = getMathContainer(state);
  if (!container || !container.passToMathJax) return null;
  return {
    pos: container.pos,
    above: true,
    strictSide: false,
    arrow: false,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-math-preview';
      try {
        katex.render(cleanForPreview(container.content), dom, {
          displayMode: container.displayMode,
          throwOnError: false,
          errorColor: '#c62828',
          strict: 'ignore',
          trust: false,
          macros: documentMacros(state),
        });
      } catch (e) {
        dom.textContent = String((e as Error).message);
        dom.classList.add('error');
      }
      return { dom };
    },
  };
}

const mathPreviewField = StateField.define<Tooltip | null>({
  create: buildTooltip,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return buildTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});

const mathPreviewTheme = EditorView.baseTheme({
  '.cm-tooltip.cm-tooltip-above:has(.cm-math-preview), .cm-tooltip:has(> .cm-math-preview)': {
    background: '#fff',
    border: '1px solid #d0d7de',
    borderRadius: '6px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
  },
  '.cm-math-preview': { padding: '6px 10px', maxWidth: '640px', overflowX: 'auto', fontSize: '15px' },
  '.cm-math-preview.error': { color: '#c62828', fontSize: '12px' },
});

export function mathPreview() {
  return [mathPreviewField, mathPreviewTheme];
}
