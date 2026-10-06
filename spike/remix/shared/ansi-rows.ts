// Terminal screen model for the spike. Parsing reuses Collie's own pure SGR parser and line
// splitter from web/src/lib (imported read-only by relative path; both are React-free at runtime,
// they only import a React *type*). The spike adds nothing to parsing; it only flattens the
// segments into rows of { text, style } for rendering.
import { parseAnsi, type AnsiSegment } from '../../../web/src/lib/ansi.ts'
import { splitLines } from '../../../web/src/lib/blocks.ts'

/** The six declarations Collie's parser can set (`buildStyle` in web/src/lib/ansi.ts). A type
 *  alias, not an interface: Remix's StyleProps has a string index signature, and only an alias
 *  gets an implicit one. */
export type CellStyle = {
  color?: string
  backgroundColor?: string
  fontWeight?: string | number
  fontStyle?: string
  opacity?: string | number
  textDecoration?: string | number
}


export interface Cell {
  text: string
  style: CellStyle
}

/** Copies the parser's React-typed style into a plain object Remix's `style` prop accepts. */
function cellStyle(source: AnsiSegment['style']): CellStyle {
  let style: CellStyle = {}
  if (source.color !== undefined) style.color = source.color
  if (source.backgroundColor !== undefined) style.backgroundColor = source.backgroundColor
  if (source.fontWeight !== undefined) style.fontWeight = source.fontWeight
  if (source.fontStyle !== undefined) style.fontStyle = source.fontStyle
  if (source.opacity !== undefined) style.opacity = source.opacity
  if (source.textDecoration !== undefined) style.textDecoration = source.textDecoration
  return style
}

export interface Row {
  /** Stable identity for keyed rendering. */
  key: string
  cells: Cell[]
}

export function toRows(text: string, generation = 0): Row[] {
  let lines = splitLines(parseAnsi(text))
  return lines.map((line, i) => ({
    key: `${generation}:${i}`,
    cells: line.segments.map((seg) => ({ text: seg.text, style: cellStyle(seg.style) })),
  }))
}

export function countSpans(rows: Row[]): number {
  let n = 0
  for (let row of rows) n += row.cells.length
  return n
}
