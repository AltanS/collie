import './app.css'
import { navigate } from 'remix/component'
import { createRouter } from 'remix/router'
import { get, route } from 'remix/routes'
import { render, run } from 'remix/spa'
import { CostLab, costLab } from './labs/cost.tsx'
import { GestureLab, gestureLab } from './labs/gesture.tsx'
import { ImperativeLab, imperativeLab } from './labs/imperative.tsx'
import { MotionLab, motionLab } from './labs/motion.tsx'
import { QueueLab, queueLab } from './labs/queue.tsx'
import { ReorderLab, reorderLab, type ReorderMode } from './labs/reorder.tsx'
import { Home, ListPage, NotFound, PaneView } from './pages.tsx'
import { probe, wait } from './probe.ts'
import { Shell, clock, currentViewTransition, currentVtGate, updateShell } from './shell.tsx'

const routes = route({
  home: get('/'),
  list: get('/list'),
  pane: get('/pane/:id'),
  lab: get('/lab/:name'),
})

function reorderMode(value: string | null): ReorderMode {
  if (value === 'flip' || value === 'plain') return value
  return 'css'
}

const router = createRouter({
  middleware: [
    async (_context, next) => {
      // Q4 gated seam: hold the route until the view transition has its old snapshot.
      let gate = currentVtGate()
      if (gate) await gate
      return next()
    },
    // The shell lives at module scope and wraps every route body.
    render((content, { url }) => <Shell url={url}>{content}</Shell>),
  ],
  defaultHandler({ render: respond, url }) {
    return respond(<NotFound url={url} />, { status: 404 })
  },
})

router.map(routes, {
  actions: {
    home({ render: respond }) {
      return respond(<Home />)
    },
    async list({ render: respond }) {
      await wait(probe.flags.listDelayMs)
      return respond(<ListPage />)
    },
    pane({ render: respond, params, url }) {
      return respond(probe.flags.paneKeyed ? <PaneView key={url.pathname} id={params.id} /> : <PaneView id={params.id} />)
    },
    lab({ render: respond, params, url }) {
      switch (params.name) {
        case 'queue':
          return respond(<QueueLab />)
        case 'reorder':
          return respond(
            <ReorderLab n={Number(url.searchParams.get('n') ?? 30)} mode={reorderMode(url.searchParams.get('mode'))} />,
          )
        case 'motion':
          return respond(<MotionLab />)
        case 'imperative':
          return respond(<ImperativeLab />)
        case 'cost':
          return respond(<CostLab />)
        case 'gesture':
          return respond(<GestureLab />)
        default:
          return respond(<NotFound url={url} />, { status: 404 })
      }
    },
  },
})

const app = run(router)
app.addEventListener('error', (event) => console.error('Remix SPA failed:', event.error))

export const p5 = {
  probe,
  /** Element identity across navigations, held weakly so a replaced node can be collected. */
  marks: new Map<string, WeakRef<Element>>(),
  navigate,
  clock,
  updateShell,
  currentViewTransition,
  hasViewTransitions: 'startViewTransition' in document,
  queueLab,
  reorderLab,
  motionLab,
  imperativeLab,
  costLab,
  gestureLab,
  ready: () => app.ready(),
}

declare global {
  interface Window {
    __p5?: typeof p5
  }
}

window.__p5 = p5
await app.ready()
