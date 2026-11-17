import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { forwardSearch, parseSynctex, reverseSearch } from './synctex.js';

// 夹具：tectonic 编译 __fixtures__/sample-synctex.tex（含 \input{sec/other}）的真实输出。
// 期望坐标由 pdf.js 从对应 PDF 中提取（单位 bp，原点左上，y 为基线）。
const idx = parseSynctex(
  readFileSync(path.join(import.meta.dirname, '../__fixtures__/sample.synctex.gz')),
  ['main.tex', 'sec/other.tex'],
);

const WORDS = [
  { word: 'ALPHAWORD', file: 'main.tex', line: 5, page: 1, x: 279.0, y: 156.6, w: 52 },
  { word: 'BETAWORD', file: 'main.tex', line: 8, page: 1, x: 270.8, y: 192.5, w: 46 },
  { word: 'GAMMAWORD', file: 'sec/other.tex', line: 2, page: 1, x: 182.4, y: 204.4, w: 56 },
  { word: 'OMEGAWORD', file: 'main.tex', line: 13, page: 1, x: 220.3, y: 248.3, w: 56 },
  { word: 'DELTAWORD', file: 'main.tex', line: 15, page: 2, x: 217.1, y: 134.8, w: 54 },
];

test('synctex inputs map absolute paths back to project paths', () => {
  const mapped = [...idx.inputs.values()].filter(Boolean).sort();
  assert.deepEqual(mapped, ['main.tex', 'sec/other.tex']);
});

for (const w of WORDS) {
  test(`forward search ${w.file}:${w.line} highlights ${w.word}`, () => {
    const r = forwardSearch(idx, w.file, w.line);
    assert.ok(r);
    assert.equal(r.page, w.page);
    assert.ok(
      r.rects.some((b) => w.x >= b.x - 2 && w.x <= b.x + b.w + 2 && w.y >= b.y - 2 && w.y <= b.y + b.h + 2),
      JSON.stringify(r.rects),
    );
  });

  test(`reverse search on ${w.word} returns ${w.file}:${w.line}`, () => {
    assert.deepEqual(reverseSearch(idx, w.page, w.x + w.w / 2, w.y - 3), { file: w.file, line: w.line });
  });
}

test('forward search falls back to the nearest following line', () => {
  // 第 6 行是段落中间的源码换行，第 7 行是空行，都应落到附近有内容的行
  const r = forwardSearch(idx, 'main.tex', 7);
  assert.ok(r && r.line >= 7);
});
