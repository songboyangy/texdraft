import type { ProjectSnapshot } from './overleaf/infrastructure/project-snapshot';
import type { WordCountData } from './overleaf/features/word-count-modal/components/word-count-data';
import { countWordsInFile } from './overleaf/features/word-count-modal/utils/count-words-in-file';
import { createSegmenters } from './overleaf/features/word-count-modal/utils/segmenters';

export type { WordCountData };

/** 用一组 {path, content} 实现 Overleaf 字数统计需要的项目快照接口 */
export function snapshotFrom(texts: { path: string; content: string }[]): ProjectSnapshot {
  const byPath = new Map(texts.map((f) => [f.path, f.content]));
  return {
    // Overleaf 语义：filePath 相对 basePath（以 / 开头的目录）解析；省略扩展名时补 .tex
    locateFile(filePath: string, basePath: string) {
      const joined = (filePath.startsWith('/') ? filePath : `${basePath.replace(/\/$/, '')}/${filePath}`)
        .split('/')
        .reduce<string[]>((acc, seg) => (seg === '..' ? acc.slice(0, -1) : seg && seg !== '.' ? [...acc, seg] : acc), [])
        .join('/');
      for (const cand of [joined, `${joined}.tex`, filePath, `${filePath}.tex`]) if (byPath.has(cand)) return cand;
      return null;
    },
    getDocContents(path: string) {
      return byPath.get(path) ?? null;
    },
  };
}

/** 统计从 mainFile 出发（递归 \input / \include）的整篇文档字数 */
export function countProjectWords(texts: { path: string; content: string }[], mainFile: string, locale?: string): WordCountData {
  const data: WordCountData = {
    encode: 'utf-8', textWords: 0, textCharacters: 0, headWords: 0, headCharacters: 0, abstractWords: 0,
    abstractCharacters: 0, captionWords: 0, captionCharacters: 0, footnoteWords: 0, footnoteCharacters: 0, outside: 0,
    otherWords: 0, otherCharacters: 0, headers: 0, elements: 0, mathInline: 0, mathDisplay: 0, errors: 0, messages: '',
  };
  countWordsInFile(data, snapshotFrom(texts), mainFile, '/', createSegmenters(locale));
  return data;
}
