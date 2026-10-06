// Q7: a host with no vdom children, filled imperatively, under 60 parent re-renders.
import { ref, type Handle } from 'remix/component'
import { nextFrame } from '../probe.ts'

const ROWS = 100

function fill(node: HTMLElement): void {
  for (let index = 0; index < ROWS; index++) {
    let row = document.createElement('div')
    row.className = 'imp-row'
    row.textContent = `imperative row ${index}`
    node.append(row)
  }
}

/** No vdom children at all: the reconciler has nothing to diff below the host. */
function Painted(handle: Handle<{ count: number; preserve: boolean }>) {
  return () =>
    handle.props.preserve ? (
      <div class="imp" data-testid="imp-preserve" data-count={String(handle.props.count)} data-rmx-preserve-dom mix={[ref(fill)]} />
    ) : (
      <div class="imp" data-testid="imp-plain" data-count={String(handle.props.count)} mix={[ref(fill)]} />
    )
}

/** One vdom child plus imperative siblings: what does the diff do with nodes it does not own? */
function Mixed(handle: Handle<{ count: number }>) {
  return () => (
    <div class="imp" data-testid="imp-mixed" mix={[ref(fill)]}>
      <span class="imp-owned">vdom child {handle.props.count}</span>
    </div>
  )
}

let rerender: ((times: number) => Promise<number>) | undefined

export function ImperativeLab(handle: Handle) {
  let count = 0
  rerender = async (times) => {
    for (let index = 0; index < times; index++) {
      count++
      await handle.update()
      // One update per frame: 60 awaited updates in one task would trip the cascade guard.
      await nextFrame()
    }
    return count
  }
  return () => (
    <section class="page" data-testid="imperative">
      <p data-testid="imp-count">{String(count)}</p>
      <Painted count={count} preserve={false} />
      <Painted count={count} preserve />
      <Mixed count={count} />
    </section>
  )
}

function snapshot(testId: string) {
  let node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!node) return null
  return {
    rows: node.querySelectorAll('.imp-row').length,
    owned: node.querySelectorAll('.imp-owned').length,
    firstChildText: node.firstChild?.textContent ?? null,
    dataCount: node.dataset.count ?? null,
  }
}

export const imperativeLab = {
  async run(times: number) {
    if (!rerender) throw new Error('imperative lab not mounted')
    let ids = ['imp-plain', 'imp-preserve', 'imp-mixed']
    let nodes = ids.map((id) => document.querySelector(`[data-testid="${id}"]`))
    let firstRows = nodes.map((node) => node?.querySelector('.imp-row'))
    let before = Object.fromEntries(ids.map((id) => [id, snapshot(id)]))
    let rendered = await rerender(times)
    let after = Object.fromEntries(ids.map((id) => [id, snapshot(id)]))
    let sameHost = ids.map((id, index) => document.querySelector(`[data-testid="${id}"]`) === nodes[index])
    let sameFirstRow = ids.map((id, index) => {
      let host = document.querySelector(`[data-testid="${id}"]`)
      return host?.querySelector('.imp-row') === firstRows[index] && firstRows[index] !== null
    })
    return { parentRenders: rendered, before, after, sameHost, sameFirstRow, order: ids }
  },
}
