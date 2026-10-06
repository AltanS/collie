import { createRouter } from 'remix/router'
import { render as spaRender } from 'remix/spa'
import { toRows } from '../../shared/ansi-rows.ts'
import { findPane, panes } from '../../shared/fixtures.ts'
import { NotFound, PaneList, PanePage, Shell } from './pages.tsx'
import { routes } from './routes.ts'

/** Router requests seen, so probe 4 can tell an in-page navigation from a document load. */
export const routerLog: string[] = []

export const router = createRouter({
  middleware: [
    async (context, next) => {
      routerLog.push(`${context.method} ${context.url.pathname}`)
      return next()
    },
    spaRender((content, { url }) => <Shell url={url}>{content}</Shell>),
  ],
  defaultHandler({ render, url }) {
    return render(<NotFound url={url} />, { status: 404 })
  },
})

router.map(routes, {
  actions: {
    home({ render }) {
      return render(<PaneList panes={panes} />)
    },
    async pane({ render, params, url }) {
      let pane = findPane(params.id)
      if (!pane) return render(<NotFound url={url} />, { status: 404 })
      let rows = toRows(await pane.load())
      return render(<PanePage pane={pane} rows={rows} />)
    },
  },
})
