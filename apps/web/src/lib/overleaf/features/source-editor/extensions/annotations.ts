// TeXdraft 桩文件：Overleaf 原文件包含编译日志标注与埋点；语法检查只需要 renderMessage。
import type { Diagnostic } from '@codemirror/lint'

export const renderMessage = (diagnostic: Diagnostic) => {
  const div = document.createElement('div')
  div.classList.add('ol-cm-diagnostic-message')
  div.append(diagnostic.message)
  return div
}
