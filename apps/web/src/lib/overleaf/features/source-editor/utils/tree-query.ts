/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/utils/tree-query.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
export { getNestingLevel, nestOutline } from './tree-operations/outline'

export type {
  FlatOutline,
  FlatOutlineItem,
  Outline,
} from './tree-operations/outline'

export { previousSiblingIs } from './tree-operations/common'

export {
  cursorIsAtBeginEnvironment,
  cursorIsAtEndEnvironment,
  getEnvironmentArguments,
} from './tree-operations/environments'

export {
  ancestorNodeOfType,
  ancestorOfNodeWithType,
  getBibkeyArgumentNode,
  descendantsOfNodeWithType,
  matchingAncestor,
} from './tree-operations/ancestors'

export {
  NormalTextSpan,
  getNormalTextSpansFromLine,
} from './tree-operations/text'

export {
  ifInType,
  isInEmptyArgumentNodeForAutocomplete,
} from './tree-operations/completions'

export { tokenNames, Tokens } from './tree-operations/tokens'

export {
  commentIsOpenFold,
  commentIsCloseFold,
  findClosingFoldComment,
  getFoldRange,
} from './tree-operations/comments'
