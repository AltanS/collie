// Probe 5 driver. Usage: bun probe5-motion/run.ts http://127.0.0.1:5190 chromium [q1,q2,...]
// WebKit needs libicu74, which Fedora lacks; run it from the Ubuntu distrobox `wk`:
//   distrobox enter wk -- ~/.bun/bin/bun probe5-motion/run.ts http://127.0.0.1:5190 webkit
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5190'
const browserName = process.argv[3] ?? 'chromium'
const only = process.argv[4]?.split(',')
const shotDir = `${import.meta.dirname}/results`

type Section = (page: Page, context: BrowserContext) => Promise<object>

async function open(page: Page, path: string, testId: string): Promise<void> {
  await page.goto(base + path)
  await page.getByTestId(testId).waitFor({ timeout: 10000 })
  await page.evaluate(() => window.__p5?.ready())
}

async function route(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('main')?.getAttribute('data-route') ?? null)
}

async function waitRoute(page: Page, path: string): Promise<void> {
  await page.waitForFunction((want) => document.querySelector('main')?.getAttribute('data-route') === want, path, {
    timeout: 10000,
  })
}

async function mark(page: Page, name: string, selector: string): Promise<void> {
  await page.evaluate(
    ([key, css]) => {
      let node = document.querySelector(css)
      if (node) window.__p5?.marks.set(key, new WeakRef(node))
    },
    [name, selector],
  )
}

async function same(page: Page, name: string, selector: string): Promise<boolean> {
  return page.evaluate(([key, css]) => {
    let held = window.__p5?.marks.get(key)?.deref()
    return held !== undefined && held === document.querySelector(css)
  }, [name, selector])
}

async function counters(page: Page) {
  return page.evaluate(() => {
    let probe = window.__p5?.probe
    if (!probe) throw new Error('no probe')
    return {
      shellSetups: probe.shell.setups,
      shellRenders: probe.shell.renders,
      paneSetups: probe.pane.setups,
      listSetups: probe.list.setups,
      navEvents: probe.nav.length,
    }
  })
}

/** One in-page navigation step, with what the shell did during it. */
async function step(page: Page, label: string, go: () => Promise<void>, path: string) {
  let before = await counters(page)
  let navBefore = before.navEvents
  await go()
  await waitRoute(page, path)
  await page.waitForTimeout(50)
  let after = await counters(page)
  let navEvents = await page.evaluate((from) => window.__p5?.probe.nav.slice(from) ?? [], navBefore)
  return {
    step: label,
    route: await route(page),
    headerSameNode: await same(page, 'header', 'header'),
    headerMutatedAttrKept: await page.evaluate(() => document.querySelector('header')?.getAttribute('data-mutated') === 'yes'),
    shellSetups: after.shellSetups - before.shellSetups,
    shellRenders: after.shellRenders - before.shellRenders,
    navEvents: navEvents.map((event) => `${event.type} frame.src=${new URL(event.frameSrc).pathname} location=${new URL(event.location).pathname}`),
  }
}

async function navSequence(page: Page) {
  await open(page, '/', 'home')
  await page.evaluate(() => document.querySelector('header')?.setAttribute('data-mutated', 'yes'))
  await mark(page, 'header', 'header')
  return [
    await step(page, '/ -> /list (link)', () => page.getByTestId('nav-list').click(), '/list'),
    await step(page, '/list -> /pane/1 (row link)', () => page.getByTestId('row-1').click(), '/pane/1'),
    await step(page, 'back -> /list', () => page.evaluate(() => history.back()), '/list'),
    await step(page, 'back -> /', () => page.evaluate(() => history.back()), '/'),
  ]
}

async function paneState(page: Page, keyed: boolean) {
  await page.evaluate((flag) => {
    let probe = window.__p5?.probe
    if (probe) probe.flags.paneKeyed = flag
  }, keyed)
  await page.getByTestId('nav-pane-1').click()
  await waitRoute(page, '/pane/1')
  for (let tap = 0; tap < 3; tap++) await page.getByTestId('tap').click()
  let tapsOn1 = await page.getByTestId('taps').textContent()
  await mark(page, 'title', '[data-testid="pane-title"]')
  let before = await counters(page)
  await page.getByTestId('nav-pane-2').click()
  await waitRoute(page, '/pane/2')
  let after = await counters(page)
  return {
    keyed,
    tapsOnPane1: tapsOn1,
    tapsAfterPane2: await page.getByTestId('taps').textContent(),
    titleAfter: await page.getByTestId('pane-title').textContent(),
    titleSameNode: await same(page, 'title', '[data-testid="pane-title"]'),
    paneSetupsDuringNav: after.paneSetups - before.paneSetups,
  }
}

interface VtCase {
  name: string
  mode: 'naive' | 'gated'
  start: string
  startTestId: string
  to: string
  via: 'link' | 'navigate' | 'back'
  linkTestId?: string
  shots?: boolean
  /** Check whether the page paints while the update callback hangs. */
  freezeProbe?: boolean
}

const vtCases: VtCase[] = [
  { name: 'naive-link-slow', mode: 'naive', start: '/', startTestId: 'home', to: '/list', via: 'link', linkTestId: 'nav-list' },
  { name: 'naive-link-fast-morph', mode: 'naive', start: '/list', startTestId: 'list', to: '/pane/3', via: 'link', linkTestId: 'row-3', shots: true, freezeProbe: true },
  { name: 'naive-navigate-fast', mode: 'naive', start: '/list', startTestId: 'list', to: '/pane/3', via: 'navigate' },
  { name: 'gated-link-slow', mode: 'gated', start: '/', startTestId: 'home', to: '/list', via: 'link', linkTestId: 'nav-list' },
  { name: 'gated-link-fast-morph', mode: 'gated', start: '/list', startTestId: 'list', to: '/pane/3', via: 'link', linkTestId: 'row-3', shots: true },
  { name: 'gated-navigate-fast-morph', mode: 'gated', start: '/list', startTestId: 'list', to: '/pane/3', via: 'navigate' },
  { name: 'gated-back-morph', mode: 'gated', start: '/list', startTestId: 'list', to: '/list', via: 'back' },
]

async function vtCase(page: Page, item: VtCase, browser: string) {
  await open(page, item.start, item.startTestId)
  if (item.via === 'back') {
    // Build the history first: /list -> /pane/3, then go back with the transition on.
    await page.getByTestId('row-3').click()
    await waitRoute(page, '/pane/3')
  }
  await page.evaluate((mode) => {
    let probe = window.__p5?.probe
    if (!probe) return
    probe.flags.vt = mode
    probe.vt.length = 0
  }, item.mode)
  if (item.shots) await page.screenshot({ path: `${shotDir}/q4-${browser}-${item.name}-before.jpg`, type: 'jpeg', quality: 50 })
  let started = Date.now()
  if (item.via === 'link' && item.linkTestId) await page.getByTestId(item.linkTestId).click()
  if (item.via === 'navigate') await page.evaluate((to) => void window.__p5?.navigate(to), item.to)
  if (item.via === 'back') await page.evaluate(() => history.back())
  let freeze: object | null = null
  if (item.freezeProbe) {
    await page.waitForTimeout(800)
    freeze = await page.evaluate(async () => {
      let start = performance.now()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      let firstFrameAfterMs = Math.round(performance.now() - start)
      let vt = window.__p5?.probe.vt.at(-1)
      return { probeStartedMsAfterClick: 800, firstAnimationFrameAfterMs: firstFrameAfterMs, readyStateThen: vt?.ready ?? null }
    })
  }
  let atReady = await page.evaluate(async () => {
    let vt = window.__p5?.currentViewTransition()
    if (!vt) return { hadTransition: false, readyAfterMs: null, pseudo: null }
    let start = performance.now()
    let ready = await Promise.race([
      vt.ready.then(
        () => 'ok',
        (error: Error) => `rejected: ${error.name}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout 6s'), 6000)),
    ])
    let pseudoElements = document
      .getAnimations()
      .map((animation) => (animation.effect instanceof KeyframeEffect ? animation.effect.pseudoElement : null))
      .filter((name) => name !== null)
    let unique = [...new Set(pseudoElements)]
    let groups = unique.filter((name) => name.startsWith('::view-transition-group(')).map((name) => name.slice(24, -1))
    let paired = groups.filter((name) => unique.includes(`::view-transition-old(${name})`) && unique.includes(`::view-transition-new(${name})`))
    let summary = {
      groups: groups.filter((name) => !name.startsWith('pane-') || paired.includes(name)),
      pairedOldAndNew: paired,
      newOnlyCount: unique.filter((name) => name.startsWith('::view-transition-new(') && !paired.some((p) => name.endsWith(`(${p})`))).length,
      oldOnlyCount: unique.filter((name) => name.startsWith('::view-transition-old(') && !paired.some((p) => name.endsWith(`(${p})`))).length,
    }
    for (let animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = 0
    }
    return { hadTransition: true, ready, readyAfterMs: Math.round(performance.now() - start), pseudo: summary }
  })
  if (item.shots) {
    await page.screenshot({ path: `${shotDir}/q4-${browser}-${item.name}-t0.jpg`, type: 'jpeg', quality: 50 })
    await page.evaluate(() => {
      for (let animation of document.getAnimations()) animation.currentTime = 200
    })
    await page.screenshot({ path: `${shotDir}/q4-${browser}-${item.name}-t50.jpg`, type: 'jpeg', quality: 50 })
  }
  await page.evaluate(() => {
    for (let animation of document.getAnimations()) animation.play()
  })
  await waitRoute(page, item.to)
  await page.waitForFunction(() => window.__p5?.probe.vt.every((record) => record.finished !== 'pending'), null, { timeout: 8000 }).catch(() => undefined)
  let records = await page.evaluate(() => window.__p5?.probe.vt ?? [])
  return { case: item.name, wallMs: Date.now() - started, freeze, atReady, records, routeAfter: await route(page) }
}

async function setFlag(page: Page, name: 'restoreScroll' | 'progress', value: boolean): Promise<void> {
  await page.evaluate(
    ([key, flag]) => {
      let probe = window.__p5?.probe
      if (probe) probe.flags[key] = flag
    },
    [name, value] as const,
  )
}

async function scrollState(page: Page) {
  return page.evaluate(() => {
    let scroller = document.querySelector('[data-testid="scroller"]')
    if (!scroller) return null
    let box = scroller.getBoundingClientRect()
    let topRow = document.elementFromPoint(box.left + 20, box.top + 5)?.closest('a')?.textContent ?? null
    return { scrollTop: Math.round(scroller.scrollTop), topRow, windowScrollY: window.scrollY }
  })
}

async function scrollTrial(page: Page, restore: boolean) {
  await open(page, '/list', 'list')
  await setFlag(page, 'restoreScroll', restore)
  await page.evaluate(() => {
    let scroller = document.querySelector('[data-testid="scroller"]')
    let row = document.querySelector('[data-testid="row-25"]')
    if (!scroller || !row) return
    scroller.scrollTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  })
  await page.waitForTimeout(150)
  let before = await scrollState(page)
  await page.getByTestId('nav-pane-1').click()
  await waitRoute(page, '/pane/1')
  await page.evaluate(() => history.back())
  await waitRoute(page, '/list')
  await page.waitForTimeout(150)
  let afterBack = await scrollState(page)
  await page.evaluate(() => history.forward())
  await waitRoute(page, '/pane/1')
  await page.evaluate(() => history.back())
  await waitRoute(page, '/list')
  await page.waitForTimeout(150)
  let afterSecondBack = await scrollState(page)
  await page.getByTestId('nav-pane-1').click()
  await waitRoute(page, '/pane/1')
  await page.getByTestId('nav-list').click()
  await waitRoute(page, '/list')
  await page.waitForTimeout(150)
  let freshPushToList = await scrollState(page)
  return { restore, before, afterBack, afterSecondBack, freshPushToList }
}

async function gestureCount(page: Page) {
  return page.evaluate(() => ({
    longPresses: Number(document.querySelector('[data-testid="longpress-count"]')?.textContent ?? -1),
    swipes: Number(document.querySelector('[data-testid="swipe-count"]')?.textContent ?? -1),
    log: window.__p5?.gestureLab.log.splice(0) ?? [],
  }))
}

async function center(page: Page, testId: string) {
  let box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} has no box`)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function mouseCases(page: Page) {
  let press = await center(page, 'press')
  await gestureCount(page)

  await page.mouse.move(press.x, press.y)
  await page.mouse.down()
  await page.waitForTimeout(650)
  await page.mouse.up()
  await page.waitForTimeout(50)
  let hold650 = await gestureCount(page)

  await page.mouse.down()
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(400)
  let hold300 = await gestureCount(page)

  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.mouse.move(press.x, press.y + 150, { steps: 5 })
  await page.waitForTimeout(550)
  await page.mouse.up()
  await page.mouse.move(press.x, press.y)
  await page.waitForTimeout(50)
  let dragOutWhileCaptured = await gestureCount(page)

  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    document.querySelector('[data-testid="press"]')?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, isPrimary: true }))
  })
  await page.waitForTimeout(550)
  await page.mouse.up()
  let syntheticPointercancel = await gestureCount(page)

  let area = await center(page, 'swipe')
  await page.mouse.move(area.x + 100, area.y)
  await page.mouse.down()
  for (let move = 1; move <= 6; move++) {
    await page.mouse.move(area.x + 100 - move * 30, area.y)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(50)
  let fastSwipeLeft180px = await gestureCount(page)

  await page.mouse.move(area.x, area.y)
  await page.mouse.down()
  for (let move = 1; move <= 6; move++) {
    await page.mouse.move(area.x + move * 5, area.y)
    await page.waitForTimeout(100)
  }
  await page.mouse.up()
  await page.waitForTimeout(50)
  let slowDrag30px = await gestureCount(page)
  return { hold650, hold300, dragOutWhileCaptured, syntheticPointercancel, fastSwipeLeft180px, slowDrag30px }
}

async function touchCases(page: Page, context: BrowserContext) {
  let cdp = await context.newCDPSession(page)
  let touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  }
  await gestureCount(page)
  let press = await center(page, 'press')
  await touch('touchStart', press.x, press.y)
  await page.waitForTimeout(650)
  await touch('touchEnd', press.x, press.y)
  await page.waitForTimeout(50)
  let touchHold650 = await gestureCount(page)

  let area = await center(page, 'swipe')
  await touch('touchStart', area.x + 100, area.y)
  for (let move = 1; move <= 6; move++) {
    await touch('touchMove', area.x + 100 - move * 30, area.y)
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', area.x - 80, area.y)
  await page.waitForTimeout(50)
  let touchSwipeLeft180px = await gestureCount(page)

  let scrollBefore = await page.evaluate(() => window.scrollY)
  await touch('touchStart', area.x, area.y + 40)
  for (let move = 1; move <= 6; move++) {
    await touch('touchMove', area.x, area.y + 40 - move * 30)
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', area.x, area.y - 140)
  await page.waitForTimeout(300)
  let touchVerticalDrag180px = { ...(await gestureCount(page)), windowScrolledBy: (await page.evaluate(() => window.scrollY)) - scrollBefore }
  return { touchHold650, touchSwipeLeft180px, touchVerticalDrag180px }
}

const sections = {
  // Q7: imperative children under 60 parent re-renders.
  async q7(page) {
    await open(page, '/lab/imperative', 'imperative')
    return (await page.evaluate(() => window.__p5?.imperativeLab.run(60))) ?? {}
  },

  // Q8: inner scroll restoration on back, without and with the module-map idiom.
  async q8(page) {
    return { runtimeOnly: await scrollTrial(page, false), withModuleMap: await scrollTrial(page, true) }
  },

  // Q9: who re-renders when the clock updates, and when the shell updates.
  async q9(page) {
    await open(page, '/lab/cost', 'cost')
    let clockOnly = await page.evaluate(() => window.__p5?.costLab.clockOnly(2000))
    let shellUpdates = await page.evaluate(() => window.__p5?.costLab.shellUpdates(20))
    return { clockOnly: clockOnly ?? {}, shellUpdates: shellUpdates ?? {} }
  },

  // Q10: long-press and swipe mixins, mouse in every browser, touch through CDP in Chromium.
  async q10(page, context) {
    await open(page, '/lab/gesture', 'gesture')
    let mouse = await mouseCases(page)
    if (browserName !== 'chromium') return { mouse, touch: 'not run: CDP touch input is Chromium only' }
    return { mouse, touch: await touchCases(page, context) }
  },

  // Q6: entrance and exit with spring presets; reclaim of a keyed row mid-exit.
  async q6(page) {
    await open(page, '/lab/motion', 'motion')
    let exits: object[] = []
    for (let preset of ['snappy', 'smooth', 'bouncy'] as const) {
      for (let kind of ['sheet', 'toast'] as const) {
        exits.push((await page.evaluate(([k, p]) => window.__p5?.motionLab.exit(k, p), [kind, preset] as const)) ?? {})
      }
    }
    let rowExits: object[] = []
    for (let preset of ['snappy', 'smooth', 'bouncy'] as const) {
      rowExits.push((await page.evaluate((p) => window.__p5?.motionLab.rowExit(p), preset)) ?? {})
    }
    let reclaim = await page.evaluate(() => window.__p5?.motionLab.reclaim('smooth'))
    return { exits, rowExits, reclaim }
  },

  // Q5: keyed reorder against CSS transitions, then FLIP via animateLayout.
  async q5(page) {
    await open(page, '/lab/reorder?n=30&mode=css', 'reorder')
    let cssOneShot = await page.evaluate(() => window.__p5?.reorderLab.measureCssCancel() ?? null)
    await open(page, '/lab/reorder?n=30&mode=css', 'reorder')
    let cssLoop = await page.evaluate(() => window.__p5?.reorderLab.measureCssLoop(10) ?? null)
    let motion: object[] = []
    for (let [n, mode] of [
      [30, 'plain'],
      [30, 'flip'],
      [200, 'plain'],
      [200, 'flip'],
    ] as const) {
      await open(page, `/lab/reorder?n=${n}&mode=${mode}`, 'reorder')
      let result = await page.evaluate(() => window.__p5?.reorderLab.measureMotion(10) ?? null)
      motion.push({ n, mode, ...result })
    }
    return { cssOneShot, cssLoop, motion }
  },

  // Q4: view transitions from reloadStart; naive seam versus a router gate.
  async q4(page) {
    let support = await (async () => {
      await open(page, '/', 'home')
      return page.evaluate(() => window.__p5?.hasViewTransitions ?? false)
    })()
    if (!support) return { startViewTransition: false }
    let cases: object[] = []
    for (let item of vtCases) {
      cases.push(await vtCase(page, item, browserName))
    }
    return { startViewTransition: true, cases }
  },

  // Q2: the shell across navigations, with and without the pending-bar subscription re-rendering it.
  async q2(page) {
    let withProgress = await navSequence(page)
    await page.evaluate(() => {
      let probe = window.__p5?.probe
      if (probe) probe.flags.progress = false
    })
    let withoutProgress = [
      await step(page, '/ -> /list (link)', () => page.getByTestId('nav-list').click(), '/list'),
      await step(page, '/list -> /pane/1 (row link)', () => page.getByTestId('row-1').click(), '/pane/1'),
      await step(page, 'back -> /list', () => page.evaluate(() => history.back()), '/list'),
    ]
    let totals = await counters(page)
    return {
      withProgress,
      withoutProgress,
      shellSetupsWholeRun: totals.shellSetups,
      unkeyed: await paneState(page, false),
      keyedByPathname: await paneState(page, true),
    }
  },

  // Q3: the 2 px pending bar during a 300 ms route.
  async q3(page) {
    await open(page, '/', 'home')
    await page.evaluate(() => {
      let bar = document.querySelector('.progress')
      let probe = window.__p5?.probe
      if (!bar || !probe) return
      let start = performance.now()
      new MutationObserver(() => {
        probe.log.push(`bar data-active=${bar.getAttribute('data-active')} @${Math.round(performance.now() - start)}ms`)
      }).observe(bar, { attributes: true, attributeFilter: ['data-active'] })
      probe.log.length = 0
      probe.nav.length = 0
    })
    await page.getByTestId('nav-list').click()
    await page.waitForTimeout(150)
    let midWidth = await page.evaluate(() => {
      let bar = document.querySelector('.progress')
      return bar ? getComputedStyle(bar).width : null
    })
    let midHeight = await page.evaluate(() => {
      let bar = document.querySelector('.progress')
      return bar ? getComputedStyle(bar).height : null
    })
    await waitRoute(page, '/list')
    await page.waitForTimeout(100)
    let fastLog = await page.evaluate(() => {
      let probe = window.__p5?.probe
      return probe ? [...probe.log] : []
    })
    await page.evaluate(() => {
      let probe = window.__p5?.probe
      if (probe) probe.log.length = 0
    })
    await page.getByTestId('nav-pane-1').click()
    await waitRoute(page, '/pane/1')
    await page.waitForTimeout(100)
    let instantLog = await page.evaluate(() => window.__p5?.probe.log ?? [])
    let nav = await page.evaluate(() => window.__p5?.probe.nav ?? [])
    return {
      slowRoute: { barLog: fastLog, barWidthAt150ms: midWidth, barHeight: midHeight },
      instantRoute: { barLog: instantLog },
      reloadEvents: nav.map((event) => ({
        type: event.type,
        t: event.t,
        frameSrc: new URL(event.frameSrc).pathname,
        location: new URL(event.location).pathname,
      })),
    }
  },

  // Q1: queueTask without update, then with.
  async q1(page) {
    await open(page, '/lab/queue', 'queue')
    let read = () => page.evaluate(() => window.__p5?.queueLab.log.splice(0) ?? [])
    await read()
    await page.getByTestId('q-task-only').click()
    await page.waitForTimeout(500)
    let taskOnly = await read()
    await page.getByTestId('q-update-only').click()
    await page.waitForTimeout(200)
    let laterUpdate = await read()
    await page.getByTestId('q-task-update').click()
    await page.waitForTimeout(200)
    let withUpdate = await read()
    return { taskOnly, laterUpdate, withUpdate }
  },
} satisfies Record<string, Section>

interface SectionOutcome {
  result?: object
  failed?: string
  consoleErrors: string[]
}

async function main(): Promise<void> {
  let type = browserName === 'webkit' ? webkit : chromium
  let browser: Browser = await type.launch()
  let outcomes = new Map<string, SectionOutcome>()
  for (let [name, section] of Object.entries(sections)) {
    if (only && !only.includes(name)) continue
    let context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: browserName === 'chromium' })
    let page = await context.newPage()
    let errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    try {
      outcomes.set(name, { result: await section(page, context), consoleErrors: errors })
    } catch (error) {
      outcomes.set(name, { failed: String(error), consoleErrors: errors })
    }
    console.error(`${browserName} ${name} done`)
    await context.close()
  }
  let version = browser.version()
  await browser.close()
  console.log(JSON.stringify({ browser: browserName, version, ...Object.fromEntries(outcomes) }, null, 2))
}

await main()
