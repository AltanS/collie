import type { Handle } from 'remix/component'
import type { RemixNode } from 'remix/component/jsx-runtime'
import type { Row } from '../../shared/ansi-rows.ts'
import type { FakePane } from '../../shared/fixtures.ts'
import { Screen } from '../../shared/screen.tsx'
import { routes } from './routes.ts'

/** Counts how often each page component's setup runs (probe 4 reads this). */
export const setupCounts = { shell: 0, list: 0, pane: 0 }

export function Shell(handle: Handle<{ url: URL; children?: RemixNode }>) {
  setupCounts.shell++
  return () => (
    <div class="min-h-dvh flex flex-col">
      <header class="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-neutral-900/95 px-4 py-2">
        <a href={routes.home.href()} class="font-semibold text-amber-400" data-testid="home-link">
          Collie
        </a>
        <span class="text-xs text-neutral-400" data-testid="path">
          {handle.props.url.pathname}
        </span>
      </header>
      <main class="flex-1">{handle.props.children}</main>
    </div>
  )
}

export function PaneList(handle: Handle<{ panes: FakePane[] }>) {
  setupCounts.list++
  return () => (
    <ul class="divide-y divide-neutral-800" data-testid="pane-list">
      {handle.props.panes.map((pane) => (
        <li key={pane.id}>
          <a
            href={routes.pane.href({ id: pane.id })}
            class="flex items-baseline justify-between px-4 py-3 hover:bg-neutral-900"
            data-testid={`pane-link-${pane.id}`}
          >
            <span class="truncate">{pane.name}</span>
            <span class="ml-3 shrink-0 rounded border border-neutral-700 px-1.5 text-xs text-neutral-400">
              {pane.harness}
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

export function PanePage(handle: Handle<{ pane: FakePane; rows: Row[] }>) {
  setupCounts.pane++
  return () => (
    <section data-testid="pane-view">
      <h1 class="px-4 py-2 text-sm text-neutral-300" data-testid="pane-title">
        {handle.props.pane.name}
      </h1>
      <Screen rows={handle.props.rows} />
    </section>
  )
}

export function NotFound(handle: Handle<{ url: URL }>) {
  return () => <p class="p-4">Not found: {handle.props.url.pathname}</p>
}
