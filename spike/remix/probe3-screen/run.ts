// Drives the bench page in headless browsers. Serve probe3-screen/dist with the probe-1 server:
//   STATIC_DIR=probe3-screen/dist PORT=5194 bun probe1-server/server.ts
//   bun probe3-screen/run.ts http://127.0.0.1:5194 chromium 10000
//   distrobox enter wk -- ~/.bun/bin/bun probe3-screen/run.ts http://127.0.0.1:5194 webkit 10000
import { chromium, webkit, type Page } from 'playwright'
import type { BenchReport, RunOptions } from '../shared/bench-types.ts'
import '../shared/globals.ts'

const base = process.argv[2] ?? 'http://127.0.0.1:5194'
const which = process.argv[3] ?? 'chromium'
const durationMs = Number(process.argv[4] ?? 10000)
const variants = ['unkeyed', 'keyed', 'imperative'] as const
const rates = [3, 10, 30]

async function fresh(page: Page) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__bench?.ready === true)
}

let browserType = which.startsWith('webkit') ? webkit : chromium
let browser = await browserType.launch()
let context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
let page = await context.newPage()
let report: BenchReport = { browser: which, version: browser.version(), durationMs, runs: [], pageErrors: [] }
page.on('pageerror', (e) => report.pageErrors.push(e.message))

let throttles = which === 'chromium' ? [1, 4] : [1]
for (let throttle of throttles) {
  for (let hz of rates) {
    if (throttle > 1 && hz !== 30) continue
    for (let variant of variants) {
      await fresh(page)
      if (throttle > 1) {
        let cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
      }
      let options: RunOptions = { variant, hz, durationMs }
      let stats = await page.evaluate((o) => window.__bench!.run(o), options)
      report.runs.push({ throttle, ...stats })
      console.error(
        `${which} x${throttle} ${hz}Hz ${variant}: cell p50 ${stats.cellUpdateMs.p50} p95 ${stats.cellUpdateMs.p95}, full p50 ${stats.fullReplaceMs.p50}, frames>50 ${stats.frames.over50ms}`,
      )
      if (throttle > 1) {
        let cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      }
    }
  }
}
await fresh(page)
report.cascade = await page.evaluate(() => window.__bench!.cascade())
await fresh(page)
report.preserve = await page.evaluate(() => window.__bench!.preserveCheck())
await browser.close()
console.log(JSON.stringify(report, null, 2))
