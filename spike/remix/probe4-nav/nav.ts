// Probe 4 (and the browser half of probe 2): the probe-2 build served by the probe-1 server.
// Usage: bun probe4-nav/nav.ts http://127.0.0.1:5193 chromium,chromium-nonav
// WebKit needs libicu74, which Fedora lacks; run it from the Ubuntu distrobox `wk`:
//   distrobox enter wk -- ~/.bun/bin/bun probe4-nav/nav.ts http://127.0.0.1:5193 webkit,webkit-nonav
// Tells in-page navigation from a full document load by a per-boot id the app sets on load.
import { chromium, webkit, type Browser, type Page } from 'playwright'
import type { SpikeApi } from '../shared/globals.ts'

const base = process.argv[2] ?? 'http://127.0.0.1:5193'
const wanted = (process.argv[3] ?? 'chromium,webkit').split(',')

interface NavReport {
  browser: string
  version: string
  deepLinkTitle: string | null
  deepLinkRows: number
  navigationApi: boolean
  homeLinkInPage: boolean
  paneUrl: string
  listToPaneInPage: boolean
  backUrl: string
  backInPage: boolean
  forwardUrl: string
  forwardInPage: boolean
  lockShown: boolean
  remountRestoredRoute: string
  afterRemountInPage: boolean
  afterRemountRouterRequests: string[]
  afterRemountBack: string
  afterRemountBackInPage: boolean
  setupCounts: SpikeApi['setupCounts']
  documentLoads: number
  consoleErrors: string[]
}

async function boot(page: Page): Promise<string> {
  let id = await page.evaluate(() => window.__spike?.bootId)
  // A missing hook must fail loudly: two `undefined` ids would read as "same document".
  if (id === undefined) throw new Error('window.__spike is missing; the app did not boot')
  return id
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname
}

async function run(name: string, browser: Browser): Promise<NavReport> {
  let context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  if (name.endsWith('-nonav')) {
    // Emulate a browser without the Navigation API (older Safari): the runtime's feature check
    // (window.navigation + NavigateEvent.prototype.sourceElement) then fails.
    await context.addInitScript(() => {
      Object.defineProperty(window, 'navigation', { value: undefined, configurable: true })
      Object.defineProperty(window, 'NavigateEvent', { value: undefined, configurable: true })
    })
  }
  let page = await context.newPage()
  let errors: string[] = []
  let loads = 0
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('load', () => loads++)

  // Deep link straight to a pane: SPA fallback on the server, client route on the page.
  await page.goto(base + '/pane/4')
  await page.getByTestId('pane-view').waitFor({ timeout: 10000 })
  let deepLinkTitle = await page.getByTestId('pane-title').textContent()
  let deepLinkRows = await page.locator('pre.screen > div').count()
  let navigationApi = (await page.evaluate(() => window.__spike?.hasNavigationApi)) === true

  // Header link: pane -> home.
  let id0 = await boot(page)
  let loads0 = loads
  await page.getByTestId('home-link').click()
  await page.getByTestId('pane-list').waitFor()
  let homeLinkInPage = (await boot(page)) === id0 && loads === loads0

  // List -> pane by clicking a plain <a href>.
  let id1 = await boot(page)
  let loads1 = loads
  await page.getByTestId('pane-link-3').click()
  await page.getByTestId('pane-view').waitFor()
  let paneUrl = pathOf(page)
  let listToPaneInPage = (await boot(page)) === id1 && loads === loads1

  // history.back() and forward().
  let id2 = await boot(page)
  let loads2 = loads
  await page.evaluate(() => history.back())
  await page.getByTestId('pane-list').waitFor()
  let backUrl = pathOf(page)
  let backInPage = (await boot(page)) === id2 && loads === loads2
  await page.evaluate(() => history.forward())
  await page.getByTestId('pane-view').waitFor()
  let forwardUrl = pathOf(page)
  let forwardInPage = (await boot(page)) === id2 && loads === loads2

  // Idle-lock style unmount/remount of the root while the module-scope router lives on.
  let id3 = await boot(page)
  let loads3 = loads
  await page.evaluate(() => window.__spike?.lock())
  await page.getByTestId('lock').waitFor()
  await page.evaluate(() => window.__spike?.unlock())
  await page.getByTestId('pane-view').waitFor()
  let remountRestoredRoute = pathOf(page)
  let logBefore = (await page.evaluate(() => window.__spike?.routerLog.length)) ?? 0
  await page.getByTestId('home-link').click()
  await page.getByTestId('pane-list').waitFor()
  await page.getByTestId('pane-link-7').click()
  await page.getByTestId('pane-view').waitFor()
  let logAfter = (await page.evaluate(() => window.__spike?.routerLog.slice())) ?? []
  let afterRemountInPage = (await boot(page)) === id3 && loads === loads3
  await page.evaluate(() => history.back())
  await page.getByTestId('pane-list').waitFor()
  let afterRemountBack = pathOf(page)
  let afterRemountBackInPage = (await boot(page)) === id3 && loads === loads3
  let setupCounts = (await page.evaluate(() => window.__spike?.setupCounts)) ?? { shell: 0, list: 0, pane: 0 }
  await context.close()
  return {
    browser: name,
    version: browser.version(),
    deepLinkTitle,
    deepLinkRows,
    navigationApi,
    homeLinkInPage,
    paneUrl,
    listToPaneInPage,
    backUrl,
    backInPage,
    forwardUrl,
    forwardInPage,
    lockShown: true,
    remountRestoredRoute,
    afterRemountInPage,
    afterRemountRouterRequests: logAfter.slice(logBefore),
    afterRemountBack,
    afterRemountBackInPage,
    setupCounts,
    documentLoads: loads,
    consoleErrors: errors,
  }
}

let results: Array<NavReport | { browser: string; failed: string }> = []
for (let [name, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
  ['chromium-nonav', chromium],
  ['webkit-nonav', webkit],
] as const) {
  if (!wanted.includes(name)) continue
  let browser = await type.launch()
  console.error(`launched ${name} ${browser.version()}`)
  try {
    results.push(await run(name, browser))
  } catch (error) {
    results.push({ browser: name, failed: String(error) })
  } finally {
    await browser.close()
  }
}
console.log(JSON.stringify(results, null, 2))
