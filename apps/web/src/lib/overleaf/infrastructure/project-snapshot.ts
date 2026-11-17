// TeXdraft 桩文件：Overleaf 的 ProjectSnapshot 负责与服务端同步全部文档；
// 字数统计只需要 locateFile / getDocContents 两个接口，由 TeXdraft 的 lib/wordCount.ts 实现。
export interface ProjectSnapshot {
  locateFile(filePath: string, basePath: string): string | null
  getDocContents(path: string): string | null
}
