// 由 latex.grammar 生成 Lezer 解析器（latex.mjs / latex.terms.mjs），参照 Overleaf scripts/lezer-latex/generate.mjs。
// 生成文件不入库；dev / build / test / typecheck 前自动执行，grammar 未变化时跳过。
import { buildParserFile } from '@lezer/generator';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../src/lib/overleaf/features/source-editor/lezer-latex');
const grammarPath = path.join(dir, 'latex.grammar');
const parserPath = path.join(dir, 'latex.mjs');
const termsPath = path.join(dir, 'latex.terms.mjs');

const upToDate =
  existsSync(parserPath) && existsSync(termsPath) &&
  statSync(parserPath).mtimeMs >= statSync(grammarPath).mtimeMs &&
  statSync(parserPath).mtimeMs >= statSync(path.join(dir, 'tokens.mjs')).mtimeMs;

if (upToDate && !process.argv.includes('--force')) {
  console.log('lezer-latex: parser up to date');
} else {
  const t = Date.now();
  const { parser, terms } = buildParserFile(readFileSync(grammarPath, 'utf8'), { fileName: grammarPath, moduleStyle: 'es' });
  writeFileSync(parserPath, parser);
  writeFileSync(termsPath, terms);
  console.log(`lezer-latex: generated parser in ${Date.now() - t}ms`);
}
