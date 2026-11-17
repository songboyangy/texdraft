// TeXdraft 桩文件：Overleaf 原文件是“插入图片”对话框扩展；tree-operations/environments.ts
// 只用到 FigureData 作为解析结果的容器，这里提供一个最小实现（属性与 Overleaf 一致）。
type Range = { from: number; to: number }

export class FigureData {
  // eslint-disable-next-line no-useless-constructor
  constructor(private props: Record<string, any>) {}
  get from(): number { return this.props.from }
  get to(): number { return this.props.to }
  get caption(): Range | null { return this.props.caption }
  get label(): Range | null { return this.props.label }
  get file(): (Range & { path: string }) | null { return this.props.file }
  get width(): number | undefined { return this.props.width }
  get unknownGraphicsArguments(): string | undefined { return this.props.unknownGraphicsArguments }
  get graphicsCommand(): Range { return this.props.graphicsCommand }
  get graphicsCommandArguments(): Range | null { return this.props.graphicsCommandArguments }
}
