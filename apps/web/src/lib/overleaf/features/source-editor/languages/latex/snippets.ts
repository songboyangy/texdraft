/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/languages/latex/snippets.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
// 1. Convert from Ace `$1` to CodeMirror numbered placeholder format `${1}` or `#{1}` in snippets.
// Note: metadata from the server still uses the old format, so it's not enough to convert all
// the bundled data to the new format.
// 2. Add a final placeholder at the end of the snippet to allow for
// shift-tabbing back from the penultimate placeholder. See #8697.
export const prepareSnippetTemplate = (template: string): string => {
  return template.replace(/\$(\d+)/g, '#{$1}') + '${}'
}
