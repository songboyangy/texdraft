/**
 * Copied from Overleaf (https://github.com/overleaf/overleaf), commit e039ad26c5bf5422eb57b89fc7e57c75055e631d,
 * services/web/frontend/js/features/word-count-modal/components/word-count-data.ts
 * Copyright (C) Overleaf. Licensed under the GNU Affero General Public License v3.0.
 */
export type ServerWordCountData = {
  encode: string
  textWords: number
  headWords: number
  outside: number
  headers: number
  elements: number
  mathInline: number
  mathDisplay: number
  errors: number
  messages: string
}

export type WordCountData = ServerWordCountData & {
  textCharacters: number
  headCharacters: number
  captionWords: number
  captionCharacters: number
  footnoteWords: number
  footnoteCharacters: number
  abstractWords: number
  abstractCharacters: number
  otherWords: number
  otherCharacters: number
}
