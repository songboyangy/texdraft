/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/utils/tree-operations/tokens.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
import * as termsModule from '../../lezer-latex/latex.terms.mjs'

export const tokenNames: Array<string> = Object.keys(termsModule)

export const Tokens: Record<string, Array<string>> = {
  ctrlSeq: tokenNames.filter(name => name.match(/^(Begin|End|.*CtrlSeq)$/)),
  ctrlSym: tokenNames.filter(name => name.match(/^.*CtrlSym$/)),
  envName: tokenNames.filter(name => name.match(/^.*EnvName$/)),
}
