import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { autoCloseSpec, complete } from '../src/lib/latexCompletion.ts';

let fail = 0;
const ok = (c: boolean, m: string, extra = '') => { console.log(c ? 'ok  ' : 'FAIL', m, c ? '' : extra); if (!c) fail++; };
const symbols = async () => ({ labels: [{ label: 'fig:arch', file: 'main.tex', line: 3, context: '' }], citations: [{ key: 'smith2020', title: 'A Great Paper', type: 'article' }], commands: ['R'], files: ['main.tex', 'img/a.png', 'refs.bib'] });

async function run(doc: string, pick?: string) {
  const pos = doc.indexOf('|');
  let state = EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: pos } });
  const res = await complete(new CompletionContext(state, pos, false), symbols);
  if (!pick || !res) return { res, text: null as string | null };
  const opt = res.options.find((o) => o.label === pick);
  if (!opt) return { res, text: `(no option ${pick})` };
  const view = { get state() { return state; }, dispatch(spec: any) { state = spec.state ?? state.update(spec).state; } } as any;
  if (typeof opt.apply === 'function') opt.apply(view, opt, res.from, pos);
  else { const ins = opt.apply ?? opt.label; state = state.update({ changes: { from: res.from, to: pos, insert: ins }, selection: { anchor: res.from + ins.length } }).state; }
  const head = state.selection.main.head, text = state.doc.toString();
  return { res, text: text.slice(0, head) + '|' + text.slice(head) };
}
const rank = (opts: any[], prefix: string) => [...opts].filter((o) => o.label.startsWith(prefix)).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0)).map((o) => o.label);

{
  const { res } = await run('\\b|');
  const top = rank(res!.options, '\\b');
  ok(top[0] === '\\begin{}', '\\b → \\begin{} ranks first (Overleaf score)', top.slice(0, 5).join(' '));
  ok(res!.options.some((o) => o.label === '\\begin{figure} …'), '\\b also lists environments as "\\begin{figure} …"');
}
ok((await run('\\be|', '\\begin{}')).text === '\\begin{|}', 'choosing \\begin{} → \\begin{|}', (await run('\\be|', '\\begin{}')).text!);
{
  const r = await run('\\begin{f|}', '\\begin{figure} …');
  ok(r.res!.from === 0, '\\begin{f replaces from the backslash');
  ok(r.text === '\\begin{figure}\n  \\centering\n  \\includegraphics[width=0.5\\linewidth]{|}\n  \\caption{Caption}\n  \\label{fig:placeholder}\n\\end{figure}',
    '\\begin{f → full Overleaf figure template, consuming the auto-inserted }', JSON.stringify(r.text));
}
ok((await run('\\begin{myenv|', '\\begin{myenv} …')).text === '\\begin{myenv}\n  |\n\\end{myenv}', 'unknown env gets a generic begin/end snippet', (await run('\\begin{myenv|', '\\begin{myenv} …')).text!);
ok((await run('\\fr|', '\\frac{}{}')).text === '\\frac{|}{}', '\\frac{}{} inserts empty braces', (await run('\\fr|', '\\frac{}{}')).text!);
ok((await run('\\sec|', '\\section{}')).text === '\\section{|}', '\\section{} inserts empty braces');
ok((await run('\\cite{|}')).res!.options.some((o) => o.label === 'smith2020' && o.detail === 'A Great Paper'), '\\cite{ lists bib keys with titles');
ok((await run('\\cite{a,|}', 'smith2020')).text === '\\cite{a,smith2020|}', 'multi-key cite replaces only the last key', (await run('\\cite{a,|}', 'smith2020')).text!);
ok((await run('\\ref{|}')).res!.options.some((o) => o.label === 'fig:arch'), '\\ref{ lists labels');
ok((await run('\\includegraphics{|}')).res!.options.map((o) => o.label).join() === 'img/a.png', '\\includegraphics{ lists only images');
ok((await run('\\usepackage{ams|}')).res!.options.some((o) => o.label === 'amsmath'), '\\usepackage{ lists package names');
ok((await run('\\documentclass{|}')).res!.options.some((o) => o.label === 'article'), '\\documentclass{ lists classes');
{
  const { res } = await run('\\begin{itemize}\n\\begin{enumerate}\n\\end{|');
  ok(rank(res!.options, '')[0] === 'enumerate', '\\end{ suggests innermost open environment');
}
ok((await run('\\Rr|')).res!.options.some((o) => o.label === '\\R' && o.detail === '自定义'), 'project \\newcommand shows up');
function typeBrace(doc: string) {
  const pos = doc.indexOf('|');
  const state = EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: pos } });
  const spec = autoCloseSpec(state, pos, pos, '}');
  if (!spec) return null;
  const next = state.update(spec).state, h = next.selection.main.head, t = next.doc.toString();
  return t.slice(0, h) + '|' + t.slice(h);
}
ok(typeBrace('\\begin{proof|') === '\\begin{proof}\n  |\n\\end{proof}', 'typing } after \\begin{proof adds \\end{proof}');
ok(typeBrace('\\begin{proof|}') === '\\begin{proof}\n  |\n\\end{proof}', 'works when closeBrackets already inserted }');
ok(typeBrace('\\begin{proof|\n\\end{proof}') === null, 'no duplicate \\end when already closed');
// 数学模式感知：$…$ 中 \alpha 排序提高、不出现环境候选；正文中 \alpha 排序降低
{
  const { LaTeXLanguage } = await import('../src/lib/overleaf/features/source-editor/languages/latex/latex-language');
  const { ensureSyntaxTree, LanguageSupport } = await import('@codemirror/language');
  const at = async (doc: string) => {
    const pos = doc.indexOf('|');
    const state = EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: pos }, extensions: [new LanguageSupport(LaTeXLanguage)] });
    ensureSyntaxTree(state, state.doc.length, 1000);
    return (await complete(new CompletionContext(state, pos, false), symbols))!;
  };
  const inMath = await at('Let $x = \\al| $ hold.');
  const inText = await at('Some text \\al| here.');
  const b = (r: any) => r.options.find((o: any) => o.label === '\\alpha').boost;
  ok(b(inMath) > b(inText), 'math-only commands rank higher inside $...$ than in text', `${b(inMath)} vs ${b(inText)}`);
  ok(!inMath.options.some((o: any) => o.label.endsWith(' …')), 'no environment snippets offered inside math');
}
process.exit(fail ? 1 : 0);
