// TeXdraft 桩文件：替代 @overleaf/o-error（带附加信息的 Error）。
export default class OError extends Error {
  info?: Record<string, unknown>
  withInfo(info: Record<string, unknown>) {
    this.info = { ...(this.info ?? {}), ...info }
    return this
  }
}
