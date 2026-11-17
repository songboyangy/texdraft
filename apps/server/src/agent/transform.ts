import type { TransformAction } from '@texdraft/shared';

/**
 * 选中文字的 AI 改写（润色 / 翻译 / 精简 / 扩写 / 语法 / 解释 / 自定义）。
 * 不调用工具、单次生成，结果由用户在编辑器里决定是否替换。
 */

const REWRITE_RULES = `Rules:
- The input is a fragment of LaTeX source from an academic paper. Keep every LaTeX command, environment, \\cite{...}, \\ref{...}, \\label{...}, math ($...$, \\[...\\], equation environments) and comment intact unless the instruction is specifically about them.
- Do not add new citations, facts, numbers or claims that are not supported by the original text.
- Preserve the paragraph structure and line breaks where reasonable.
- Output ONLY the resulting LaTeX fragment. No explanations, no preamble, no Markdown code fences, no quotes around it.`;

const INSTRUCTIONS: Record<Exclude<TransformAction, 'custom' | 'explain' | 'translate'>, string> = {
  polish:
    'Polish the text for clear, fluent, formal academic writing. Improve word choice, flow and concision while keeping the meaning, terminology and the original language.',
  shorten: 'Make the text noticeably more concise (roughly 30–50% shorter) while keeping all key information. Keep the original language.',
  expand:
    'Expand the text into a fuller academic paragraph: elaborate the reasoning and transitions, but do not invent results, data, or references. Keep the original language.',
  grammar: 'Fix grammar, spelling, punctuation and obvious typos only. Change as little as possible. Keep the original language.',
};

const hasCjk = (s: string) => /[㐀-鿿豈-﫿]/.test(s.replace(/\\[a-zA-Z]+|\$[^$]*\$/g, ''));

export function buildTransformPrompt(opts: {
  action: TransformAction;
  text: string;
  instruction?: string;
  before?: string;
  after?: string;
  lang: 'zh-CN' | 'en';
}): { system: string; user: string } {
  const context =
    opts.before || opts.after
      ? `\n\nSurrounding context (read-only, for reference only — do not include it in the output):\n<before>\n${(opts.before ?? '').slice(-1500)}\n</before>\n<after>\n${(opts.after ?? '').slice(0, 800)}\n</after>`
      : '';

  if (opts.action === 'explain') {
    const language = opts.lang === 'en' ? 'English' : 'Simplified Chinese';
    return {
      system: `You are an expert academic writing and LaTeX assistant. Explain the selected LaTeX source clearly and concisely in ${language}. Cover what the text says (and, for math or LaTeX code, what it means or does). Use short paragraphs or a brief list; Markdown is allowed. Do not rewrite the text.`,
      user: `Selected text:\n<selection>\n${opts.text}\n</selection>${context}${opts.instruction ? `\n\nThe user asks: ${opts.instruction}` : ''}`,
    };
  }

  let instruction: string;
  if (opts.action === 'translate') {
    instruction = hasCjk(opts.text)
      ? 'Translate the text into natural, formal academic English.'
      : 'Translate the text into natural, formal academic Simplified Chinese (keep standard English technical terms in parentheses on first use when helpful).';
  } else if (opts.action === 'custom') {
    instruction = (opts.instruction ?? '').trim() || INSTRUCTIONS.polish;
  } else {
    instruction = INSTRUCTIONS[opts.action];
  }

  return {
    system: `You are an expert academic writing assistant that edits LaTeX source.\n${REWRITE_RULES}`,
    user: `Instruction: ${instruction}\n\nText to edit:\n<selection>\n${opts.text}\n</selection>${context}`,
  };
}

/** 模型偶尔会无视要求包上代码块或 <selection> 标签，这里兜底去掉 */
export function cleanTransformOutput(out: string) {
  let s = out.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1];
  s = s.replace(/^<selection>\n?/, '').replace(/\n?<\/selection>$/, '');
  return s;
}
