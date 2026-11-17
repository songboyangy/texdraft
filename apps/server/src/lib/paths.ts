import path from 'node:path';

const TEXT_EXT = new Set([
  'tex', 'bib', 'sty', 'cls', 'bst', 'bbx', 'cbx', 'txt', 'md', 'csv', 'tsv', 'dat', 'tikz', 'ltx',
  'def', 'cfg', 'clo', 'dtx', 'ins', 'json', 'yaml', 'yml', 'latexmkrc', 'gitignore', 'svg',
]);

export class PathError extends Error {}

/** 规范化项目内路径：相对、正斜杠、不允许越界 */
export function normalizeProjectPath(input: string): string {
  if (typeof input !== 'string') throw new PathError('path must be a string');
  let p = input.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (p.endsWith('/')) throw new PathError(`path must be a file, not a directory: ${input}`);
  p = path.posix.normalize(p);
  if (!p || p === '.' || p.includes('\0')) throw new PathError(`invalid path: ${input}`);
  if (p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
    throw new PathError(`path escapes the project: ${input}`);
  }
  if (p.length > 300) throw new PathError('path too long');
  return p;
}

export function isTextPath(p: string): boolean {
  const base = path.posix.basename(p).toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop()! : base;
  return TEXT_EXT.has(ext);
}
