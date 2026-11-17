/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/source-editor/languages/latex/completions/data/bibliography-styles.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
export const bibliographyStyles: Record<string, string[]> = {
  // https://www.overleaf.com/learn/latex/Bibtex_bibliography_styles
  bibtex: [
    'abbrv',
    'acm',
    'alpha',
    'apalike',
    'ieeetr',
    'plain',
    'siam',
    'unsrt',
  ],
  // https://www.overleaf.com/learn/latex/Natbib_bibliography_styles
  natbib: ['dinat', 'plainnat', 'abbrvnat', 'unsrtnat', 'rusnat', 'ksfh_nat'],
  // https://www.overleaf.com/learn/latex/Biblatex_bibliography_styles
  biblatex: [
    'numeric',
    'alphabetic',
    'authoryear',
    'authortitle',
    'verbose',
    'reading',
    'draft',
    'authoryear-icomp',
    'apa',
    'bwl-FU',
    'chem-acs',
    'chem-angew',
    'chem-biochem',
    'chem-rsc',
    'ieee',
    'mla',
    'musuos',
    'nature',
    'nejm',
    'phys',
    'science',
    'geschichtsfrkl',
    'oscola',
  ],
  // https://ctan.org/tex-archive/macros/latex/contrib/biblatex-contrib
  'biblatex-contrib': [
    // TODO
  ],
}
