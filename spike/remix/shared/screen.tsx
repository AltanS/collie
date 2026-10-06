// The screen component: a <pre> of rows, each row a <div> of styled <span>s. Wrap on by default
// (phone width), the way Collie's mirror renders.
//
// Remix needs no keys: unkeyed children are diffed by position, and that positional diff is what
// the "unkeyed" bench variant measures. Collie's oxlint config carries React's jsx-key rule, so the
// unkeyed children are built in plain loops rather than `.map()` callbacks.
import type { Handle } from 'remix/component'
import type { RemixNode } from 'remix/component/jsx-runtime'
import type { Row } from './ansi-rows.ts'

export interface ScreenProps {
  rows: Row[]
  keyed?: boolean
  wrap?: boolean
}

const preClass =
  'screen m-0 bg-[#0a0a0a] text-[#fafafa] font-mono text-[11px] leading-[1.35] p-2 overflow-x-auto'

function spansOf(row: Row): RemixNode[] {
  let spans: RemixNode[] = []
  for (let cell of row.cells) spans.push(<span style={cell.style}>{cell.text}</span>)
  return spans
}

function unkeyedRows(rows: Row[]): RemixNode[] {
  let out: RemixNode[] = []
  for (let row of rows) out.push(<div class="min-h-[1.35em]">{spansOf(row)}</div>)
  return out
}

function keyedRows(rows: Row[]): RemixNode[] {
  return rows.map((row) => (
    <div key={row.key} class="min-h-[1.35em]">
      {spansOf(row)}
    </div>
  ))
}

export function Screen(handle: Handle<ScreenProps>) {
  return () => {
    let { rows, keyed = false, wrap = true } = handle.props
    return (
      <pre class={preClass} style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }} data-rows={rows.length}>
        {keyed ? keyedRows(rows) : unkeyedRows(rows)}
      </pre>
    )
  }
}
