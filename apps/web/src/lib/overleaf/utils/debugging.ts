// TeXdraft 桩文件：调试日志仅在开发环境输出。
const dev = import.meta.env?.DEV ?? false
export const debugConsole = {
  log: (...a: unknown[]) => dev && console.debug(...a),
  warn: (...a: unknown[]) => dev && console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
}
