import { on, ref, type Handle } from 'remix/component'
import { probe, note } from './probe.ts'

export function Home() {
  return () => (
    <section class="page" data-testid="home">
      <h1>Probe 5</h1>
      <ul class="links">
        <li>
          <a href="/list">list (300 ms)</a>
        </li>
        <li>
          <a href="/pane/1">pane 1</a>
        </li>
        {['queue', 'reorder', 'motion', 'imperative', 'cost', 'gesture'].map((name) => (
          <li key={name}>
            <a href={`/lab/${name}`}>lab {name}</a>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- Q8: inner scroll memory, one map per history entry ---------------------------------------

const scrollMemory = new Map<string, number>()

function historyKey(): string {
  // Typed as possibly missing: older browsers have no Navigation API.
  let navigation: Navigation | undefined = window.navigation
  return navigation?.currentEntry?.key ?? location.href
}

export const ROW_COUNT = 60

export function ListPage(handle: Handle) {
  probe.list.setups++
  let key = historyKey()
  let scroller: HTMLElement | undefined
  if (probe.flags.restoreScroll) {
    handle.queueTask(() => {
      let saved = scrollMemory.get(key)
      if (saved !== undefined && scroller) {
        scroller.scrollTop = saved
        note(`list: restored scrollTop ${saved} for ${key}`)
      }
    })
  }
  let ids = Array.from({ length: ROW_COUNT }, (_, index) => index + 1)
  return () => {
    probe.list.renders++
    return (
      <section class="page" data-testid="list">
        <h1>List</h1>
        <div
          class="scroller"
          data-testid="scroller"
          mix={[
            ref((node) => {
              scroller = node
            }),
            on('scroll', (event) => {
              if (probe.flags.restoreScroll) scrollMemory.set(key, event.currentTarget.scrollTop)
            }),
          ]}
        >
          {ids.map((id) => (
            <a
              key={id}
              href={`/pane/${id}`}
              class="list-row"
              data-testid={`row-${id}`}
              style={{ viewTransitionName: `pane-${id}` }}
            >
              Pane {id}
            </a>
          ))}
        </div>
      </section>
    )
  }
}

export function PaneView(handle: Handle<{ id: string }>) {
  probe.pane.setups++
  let taps = 0
  return () => {
    probe.pane.renders++
    return (
      <section class="page" data-testid="pane">
        <h1 class="pane-title" data-testid="pane-title" style={{ viewTransitionName: `pane-${handle.props.id}` }}>
          Pane {handle.props.id}
        </h1>
        <button
          type="button"
          data-testid="tap"
          mix={[
            on('click', () => {
              taps++
              void handle.update()
            }),
          ]}
        >
          taps <span data-testid="taps">{String(taps)}</span>
        </button>
      </section>
    )
  }
}

export function NotFound(handle: Handle<{ url: URL }>) {
  return () => <p class="page">Not found: {handle.props.url.pathname}</p>
}
