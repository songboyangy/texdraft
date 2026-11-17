/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/utils/node-props.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
import { NodeProp } from '@lezer/common'

/**
 * A node prop that contains an array, each item of which is an array of parent node types that's
 * passed to [matchContext](https://lezer.codemirror.net/docs/ref/#common.SyntaxNodeRef.matchContext)
 * to test whether the node matches the given context. If so, the text in the node is excluded from spell checking.
 * An empty string is treated as a wildcard, so `[['']]` indicates that the node type should always be excluded.
 */
export const noSpellCheckProp = new NodeProp<string[][]>()
