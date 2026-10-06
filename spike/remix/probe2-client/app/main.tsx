import './app.css'
import { createRoot } from 'remix/component'
import { run, type Runtime } from 'remix/spa'
import type { SpikeApi } from '../../shared/globals.ts'
import { setupCounts } from './pages.tsx'
import { router, routerLog } from './router.tsx'

// Module scope: one router for the page's lifetime. The app runtime can be disposed and started
// again (Collie's idle lock unmounts the tree and mounts a lock screen), so probe 4 drives that.
let app: Runtime = start()
let lockRoot: ReturnType<typeof createRoot> | undefined

function start(): Runtime {
  let next = run(router, { fallback: <p class="p-4" role="status">Loading…</p> })
  next.addEventListener('error', (event) => console.error('Remix SPA failed:', event.error))
  return next
}

/** The same feature check the component runtime makes before it intercepts navigations. */
function hasNavigationApi(): boolean {
  // Typed as possibly missing: older browsers have neither global.
  let navigation: Navigation | undefined = window.navigation
  let navigateEvent: typeof NavigateEvent | undefined = window.NavigateEvent
  return navigation !== undefined && navigateEvent !== undefined && 'sourceElement' in navigateEvent.prototype
}

function LockScreen() {
  return () => (
    <div class="grid min-h-dvh place-items-center" data-testid="lock">
      Locked
    </div>
  )
}

const spike: SpikeApi = {
  bootId: crypto.randomUUID(),
  routerLog,
  setupCounts,
  hasNavigationApi: hasNavigationApi(),
  ready: () => app.ready(),
  lock() {
    app.dispose()
    let host = document.createElement('div')
    host.id = 'lock-host'
    document.body.replaceChildren(host)
    lockRoot = createRoot(host)
    lockRoot.render(<LockScreen />)
    lockRoot.flush()
  },
  async unlock() {
    lockRoot?.dispose()
    document.body.replaceChildren()
    app = start()
    await app.ready()
  },
}
window.__spike = spike
await app.ready()
