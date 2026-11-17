/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/extensions/toolbar/snippets.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
import { environments } from '../../languages/latex/completions/data/environments'
import { prepareSnippetTemplate } from '../../languages/latex/snippets'

export const snippets = {
  figure: prepareSnippetTemplate(environments.get('figure') as string),
  table: prepareSnippetTemplate(environments.get('table') as string),
  cite: prepareSnippetTemplate('\\cite{${}}'),
  ref: prepareSnippetTemplate('\\ref{${}}'),
}
