// Prints the probe 3 tables from results/probe3-*.json as markdown.
import type { BenchReport } from '../shared/bench-types.ts'

const files = ['probe3-chromium.json', 'probe3-webkit.json']
let reports: BenchReport[] = []
for (let f of files) reports.push(await Bun.file(new URL(f, import.meta.url)).json())

console.log('| browser | CPU | Hz | variant | cell update p50/p95/max ms | full replace p50/max ms | forced layout p95 ms | frames | frames >50 ms | LoAF >50 ms | guard fired | DOM = model |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (let d of reports) {
  for (let r of d.runs) {
    let c = r.cellUpdateMs
    let u = r.fullReplaceMs
    console.log(
      `| ${d.browser} ${d.version} | ${r.throttle}x | ${r.hz} | ${r.variant} | ${c.p50} / ${c.p95} / ${c.max} | ${u.p50} / ${u.max} | ${r.forcedLayoutMs.p95} | ${r.frames.count} | ${r.frames.over50ms} | ${r.loafOver50ms ?? 'n/a'} | ${r.guard.warn + r.guard.error} | ${r.domMatchesModel} |`,
    )
  }
}
console.log('\n| browser | burst | guard warn | guard error | update promise hung | DOM = model 50 ms later |')
console.log('|---|---|---|---|---|---|')
for (let d of reports) {
  if (!d.cascade) continue
  for (let [name, b] of Object.entries(d.cascade.bursts)) {
    console.log(`| ${d.browser} | ${name} | ${b.guardWarn} | ${b.guardError} | ${b.hungOnPendingUpdatePromise} | ${b.domMatchesModel50msLater} |`)
  }
  let c = d.cascade
  console.log(
    `| ${d.browser} | awaited60, then one more update in a later task | steps ${c.awaited60StepsCompleted} then ${c.awaited60LoopFinishedAfterThat} | resolves: ${c.awaited60NextTaskUpdateResolves} | | ${c.awaited60DomMatchesAfterSettle} |`,
  )
  console.log(`\n${d.browser} preserve: ${JSON.stringify(d.preserve)} pageErrors: ${d.pageErrors.length}\n`)
}
