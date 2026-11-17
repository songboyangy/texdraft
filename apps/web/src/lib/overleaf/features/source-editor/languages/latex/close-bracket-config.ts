/**
 * Adapted from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/languages/latex/close-bracket-config.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 *
 * TeXdraft 修改：Overleaf 使用自己 fork 的 @codemirror/autocomplete（支持 buildInsert 回调，
 * 可对 $、\[、\( 做上下文相关的自动闭合）；标准版不支持该接口，这里退化为只自动闭合 { 与 [。
 */
import { CloseBracketConfig } from '@codemirror/autocomplete'

export const closeBracketConfig: CloseBracketConfig = {
  brackets: ['{', '['],
}
