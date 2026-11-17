import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { explainSilentFailure, parseTectonicStdout, parseTexLog } from './logParser.js';

const fixture = readFileSync(path.join(import.meta.dirname, '../__fixtures__/tectonic-errors.log'), 'utf8');
const paths = ['main.tex', 'sections/intro.tex'];

test('tectonic log: error attributed to included file without extension', () => {
  const d = parseTexLog(fixture, paths);
  const err = d.find((x) => x.level === 'error');
  assert.ok(err);
  assert.equal(err.file, 'sections/intro.tex');
  assert.equal(err.line, 2);
  assert.match(err.message, /Undefined control sequence/);
});

test('tectonic log: warnings and bad boxes attributed to main file', () => {
  const d = parseTexLog(fixture, paths);
  const cite = d.find((x) => x.message.includes("Citation `missing'"));
  assert.equal(cite?.level, 'warning');
  assert.equal(cite?.file, 'main.tex');
  assert.equal(cite?.line, 4);
  const ref = d.find((x) => x.message.includes("Reference `nolabel'"));
  assert.equal(ref?.file, 'main.tex');
  assert.equal(ref?.line, 7);
  const box = d.find((x) => x.level === 'badbox');
  assert.equal(box?.file, 'main.tex');
  assert.equal(box?.line, 6);
});

test('file-line-error format (latexmk)', () => {
  const log = [
    '(./main.tex',
    './sections/intro.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    './main.tex:30: LaTeX Error: Environment figur undefined.',
    ')',
  ].join('\n');
  const d = parseTexLog(log, paths);
  assert.deepEqual(
    d.map((x) => [x.level, x.file, x.line]),
    [['error', 'sections/intro.tex', 12], ['error', 'main.tex', 30]],
  );
});

test('package warning spanning continuation lines', () => {
  const log = [
    '(./main.tex',
    'Package natbib Warning: Citation `foo\' on page 1 undefined on input line 9',
    '(natbib)                 and something else.',
    ')',
  ].join('\n');
  const [w] = parseTexLog(log, paths);
  assert.equal(w.level, 'warning');
  assert.equal(w.line, 9);
  assert.match(w.message, /^\[natbib\] .*and something else\.$/);
});

test('tectonic stdout fallback', () => {
  const out = [
    'error: sections/intro:2: Undefined control sequence',
    'warning: main.tex:6: Overfull \\hbox (195.36726pt too wide) detected at line 6',
    'error: the XeTeX engine had an unrecoverable error',
  ].join('\n');
  const d = parseTectonicStdout(out, paths);
  assert.deepEqual(
    d.map((x) => [x.level, x.file, x.line]),
    [['error', 'sections/intro.tex', 2], ['badbox', 'main.tex', 6]],
  );
});

test('explains a document that requires pdfTeX (aaai2027.sty) instead of failing silently', () => {
  const log = String.raw`(aaai2027.sty
Package: aaai2027 2027/05/04 AAAI 2027 Submission format
(iftex.sty
Package: iftex 2022/02/03 v1.0f TeX engine tests
)

 ********************************************
 * pdfTeX is required to compile this document.
 * Sorry!
 ********************************************`;
  assert.deepEqual(parseTexLog(log, ['main.tex']).filter((d) => d.level === 'error'), []);
  const tect = explainSilentFailure(log, { tectonicOnly: true });
  assert.equal(tect?.level, 'error');
  assert.match(tect!.message, /pdfTeX is required/);
  assert.match(tect!.message, /Tectonic/);
  assert.match(explainSilentFailure(log, { tectonicOnly: false })!.message, /Set the compiler to pdfLaTeX/);
  assert.match(explainSilentFailure('foo\nEmergency stop.\n', { tectonicOnly: false })!.message, /Last lines of the log: foo Emergency stop\./);
});
