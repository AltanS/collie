// Probe 3: redraw a real 300-row terminal screen at 3, 10 and 30 updates a second.
// Each tick changes a few cells; every 2 s the whole screen is replaced by the other capture.
// Variants:
//   unkeyed     <pre> of row <div>s of <span>s, handle.update() per tick
//   keyed       same, rows keyed by generation:index (a full replace remounts every row)
//   imperative  render an empty <pre> once, then write the DOM directly (textContent per cell,
//               a built fragment on full replace); handle.update() is never called per tick
// window.__bench.run(options) returns the stats; the driver is probe3-screen/run.ts.
import './app.css'
import { createRoot, ref, type Handle } from 'remix/component'
import fixtureA from '../../../../web/src/fixtures/panes/omp--v18-4-approval-write-long.txt?raw'
import fixtureB from '../../../../web/src/fixtures/panes/omp--v18-4-ask-multi.txt?raw'
import { countSpans, toRows, type Row } from '../../shared/ansi-rows.ts'
import type {
  BenchApi,
  BurstResult,
  CascadeResult,
  GuardHits,
  PreserveResult,
  RunOptions,
  RunStats,
  Summary,
  Variant,
} from '../../shared/bench-types.ts'
import { Screen } from '../../shared/screen.tsx'

// --- console hooks: the cascade guard warns at 50 and errors after 50 updates per turn -------------
const guardHits: GuardHits = { warn: 0, error: 0, messages: [] }
for (let level of ['warn', 'error'] as const) {
  let original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    let text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')
    if (/cascading|infinite loop/i.test(text)) {
      guardHits[level]++
      if (guardHits.messages.length < 5) guardHits.messages.push(text.slice(0, 200))
    }
    original(...args)
  }
}

// --- deterministic PRNG so every run mutates the same cells ---------------------------------------
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

const glyphs = '0123456789abcdef⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
function scramble(text: string, rand: () => number): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += text[i] === ' ' ? ' ' : glyphs[Math.floor(rand() * glyphs.length)]
  }
  return out
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  let sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
function summarize(values: number[]): Summary {
  let mean = values.reduce((a, b) => a + b, 0) / (values.length || 1)
  return {
    n: values.length,
    mean: +mean.toFixed(3),
    p50: +percentile(values, 50).toFixed(3),
    p95: +percentile(values, 95).toFixed(3),
    max: +Math.max(0, ...values).toFixed(3),
  }
}

// --- screen model ---------------------------------------------------------------------------------
let generation = 0
let rows: Row[] = toRows(fixtureA, generation)
let rand = prng(42)

/** Changes `count` cells in place; returns [rowIndex, cellIndex] pairs it changed. */
function mutateCells(count: number): Array<[number, number]> {
  let changed: Array<[number, number]> = []
  for (let k = 0; k < count; k++) {
    let r = Math.floor(rand() * rows.length)
    let row = rows[r]!
    if (row.cells.length === 0) continue
    let c = Math.floor(rand() * row.cells.length)
    let cell = row.cells[c]!
    let cells = row.cells.slice()
    cells[c] = { ...cell, text: scramble(cell.text, rand) }
    rows[r] = { ...row, cells }
    changed.push([r, c])
  }
  return changed
}

function fullReplace(): number {
  generation++
  let t0 = performance.now()
  rows = toRows(generation % 2 ? fixtureB : fixtureA, generation)
  return performance.now() - t0
}

// --- components -----------------------------------------------------------------------------------
interface Controller {
  /** Renders the current model; resolves when the DOM is committed. */
  update(kind: 'cells' | 'full', changed: Array<[number, number]>): Promise<void> | void
  pre(): HTMLPreElement
  /** For the cascade checks: a raw handle.update(). */
  rawUpdate(): Promise<AbortSignal>
}
let controller: Controller | undefined

function findScreen(): HTMLPreElement {
  let pre = document.querySelector<HTMLPreElement>('pre.screen')
  if (!pre) throw new Error('no pre.screen mounted')
  return pre
}

function VdomBench(handle: Handle<{ keyed: boolean }>) {
  controller = {
    async update() {
      await handle.update()
    },
    pre: findScreen,
    rawUpdate: () => handle.update(),
  }
  return () => <Screen rows={rows} keyed={handle.props.keyed} />
}

function paintRow(row: Row): HTMLDivElement {
  let div = document.createElement('div')
  div.className = 'min-h-[1.35em]'
  for (let cell of row.cells) {
    let span = document.createElement('span')
    Object.assign(span.style, cell.style)
    span.textContent = cell.text
    div.appendChild(span)
  }
  return div
}

function ImperativeBench(handle: Handle<{ preserve: boolean }>) {
  let pre!: HTMLPreElement
  let rerenders = 0
  function paintAll() {
    let frag = document.createDocumentFragment()
    for (let row of rows) frag.appendChild(paintRow(row))
    pre.replaceChildren(frag)
  }
  controller = {
    update(kind, changed) {
      if (kind === 'full') return paintAll()
      for (let [r, c] of changed) {
        let span = pre.children[r]?.children[c]
        if (span) span.textContent = rows[r]!.cells[c]!.text
      }
    },
    pre: () => pre,
    rawUpdate: () => {
      rerenders++
      return handle.update()
    },
  }
  return () => (
    <pre
      class="screen m-0 bg-[#0a0a0a] text-[#fafafa] font-mono text-[11px] leading-[1.35] p-2"
      style={{ whiteSpace: 'pre-wrap' }}
      data-rerenders={rerenders}
      {...(handle.props.preserve ? { 'data-rmx-preserve-dom': true } : {})}
      mix={ref((node: HTMLPreElement) => {
        pre = node
        paintAll()
      })}
    />
  )
}

// --- runner ---------------------------------------------------------------------------------------
let root: ReturnType<typeof createRoot> | undefined

function mount(variant: Variant | 'imperative-preserve'): number {
  root?.dispose()
  generation = 0
  rows = toRows(fixtureA, generation)
  rand = prng(42)
  let host = document.getElementById('root')!
  host.replaceChildren()
  let t0 = performance.now()
  root = createRoot(host)
  if (variant === 'unkeyed' || variant === 'keyed') root.render(<VdomBench keyed={variant === 'keyed'} />)
  else root.render(<ImperativeBench preserve={variant === 'imperative-preserve'} />)
  root.flush()
  return performance.now() - t0
}

/** Checks the rendered DOM text equals the model (catches dropped updates). */
function domMatchesModel(): boolean {
  let pre = controller!.pre()
  if (pre.children.length !== rows.length) return false
  for (let i = 0; i < rows.length; i++) {
    let expected = rows[i]!.cells.map((c) => c.text).join('')
    if (pre.children[i]!.textContent !== expected) return false
  }
  return true
}

async function run(options: RunOptions): Promise<RunStats> {
  let { variant, hz, durationMs, cellsPerTick = 4, fullReplaceEveryMs = 2000 } = options
  guardHits.warn = guardHits.error = 0
  guardHits.messages = []
  let mountMs = mount(variant)
  await new Promise((r) => setTimeout(r, 300))

  let cellTimes: number[] = []
  let fullTimes: number[] = []
  let layoutTimes: number[] = []
  let parseTimes: number[] = []
  let frameDeltas: number[] = []
  let loaf = 0
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver((list) => {
      for (let e of list.getEntries()) if (e.duration > 50) loaf++
    })
    observer.observe({ type: 'long-animation-frame', buffered: false })
  } catch {
    observer = undefined
  }
  let loafSupported = observer !== undefined && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')

  let running = true
  let last = performance.now()
  let rafLoop = (now: number) => {
    frameDeltas.push(now - last)
    last = now
    if (running) requestAnimationFrame(rafLoop)
  }
  requestAnimationFrame((now) => {
    last = now
    requestAnimationFrame(rafLoop)
  })

  let screenHeightPx = 0
  let start = performance.now()
  let lastFull = start
  let busy = false
  let skipped = 0
  await new Promise<void>((resolve) => {
    let timer = setInterval(async () => {
      let now = performance.now()
      if (now - start >= durationMs) {
        clearInterval(timer)
        resolve()
        return
      }
      if (busy) {
        skipped++
        return
      }
      busy = true
      let full = now - lastFull >= fullReplaceEveryMs
      let changed: Array<[number, number]> = []
      if (full) {
        lastFull = now
        parseTimes.push(fullReplace())
      } else {
        changed = mutateCells(cellsPerTick)
      }
      let t0 = performance.now()
      await controller!.update(full ? 'full' : 'cells', changed)
      let t1 = performance.now()
      screenHeightPx = controller!.pre().getBoundingClientRect().height // forces style + layout
      let t2 = performance.now()
      ;(full ? fullTimes : cellTimes).push(t1 - t0)
      layoutTimes.push(t2 - t1)
      busy = false
    }, 1000 / hz)
  })
  running = false
  observer?.disconnect()
  await new Promise((r) => setTimeout(r, 100))

  let frames = frameDeltas.slice(2)
  return {
    variant,
    hz,
    durationMs,
    rows: rows.length,
    spans: countSpans(rows),
    mountMs: +mountMs.toFixed(2),
    cellUpdateMs: summarize(cellTimes),
    fullReplaceMs: summarize(fullTimes),
    forcedLayoutMs: summarize(layoutTimes),
    parseMs: summarize(parseTimes),
    frames: {
      count: frames.length,
      over50ms: frames.filter((d) => d > 50).length,
      p95: +percentile(frames, 95).toFixed(2),
      max: +Math.max(0, ...frames).toFixed(2),
    },
    loafOver50ms: loafSupported ? loaf : null,
    skippedTicks: skipped,
    screenHeightPx: Math.round(screenHeightPx),
    domMatchesModel: domMatchesModel(),
    guard: { ...guardHits },
  }
}

/** Cascade guard probes: how bursts of updates within one event-loop turn behave. */
async function cascade(): Promise<CascadeResult> {
  let bursts: Record<string, BurstResult> = {}
  let awaitedSteps = 0
  async function probe(name: string, body: () => Promise<void>) {
    mount('unkeyed')
    await new Promise((r) => setTimeout(r, 50))
    guardHits.warn = guardHits.error = 0
    guardHits.messages = []
    let t0 = performance.now()
    // A dropped update may leave its handle.update() promise pending forever; cap the wait.
    let hung = await Promise.race([
      body().then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 2000)),
    ])
    let ms = performance.now() - t0
    let matchesRightAway = domMatchesModel()
    await new Promise((r) => setTimeout(r, 50))
    bursts[name] = {
      ms: +ms.toFixed(1),
      hungOnPendingUpdatePromise: hung,
      guardWarn: guardHits.warn,
      guardError: guardHits.error,
      firstMessage: guardHits.messages[0] ?? null,
      domMatchesModelAfter: matchesRightAway,
      domMatchesModel50msLater: domMatchesModel(),
    }
  }
  // 60 updates fired synchronously in one task: batched into one flush.
  await probe('sync60', async () => {
    for (let i = 0; i < 60; i++) {
      mutateCells(1)
      void controller!.rawUpdate()
    }
    await controller!.rawUpdate()
  })
  // 60 updates, each awaited, in one task: every flush is a new microtask in the same turn.
  await probe('awaited60', async () => {
    for (let i = 0; i < 60; i++) {
      mutateCells(1)
      await controller!.rawUpdate()
      awaitedSteps = i + 1
    }
  })
  let awaited60StepsCompleted = awaitedSteps
  // After the guard tripped: a later update (next task) renders, and it also settles the stuck
  // promise, which lets the paused loop above run its remaining iterations.
  mutateCells(1)
  let recovered = await Promise.race([
    controller!.rawUpdate().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ])
  await new Promise((r) => setTimeout(r, 100))
  let awaited60LoopFinishedAfterThat = awaitedSteps
  let awaited60DomMatchesAfterSettle = domMatchesModel()
  // A stream reader with 60 buffered chunks (a fetch/SSE body that arrived in one read burst).
  await probe('streamBurst60', async () => {
    let stream = new ReadableStream<number>({
      start(c) {
        for (let i = 0; i < 60; i++) c.enqueue(i)
        c.close()
      },
    })
    let reader = stream.getReader()
    for (;;) {
      let { done } = await reader.read()
      if (done) break
      mutateCells(1)
      void controller!.rawUpdate()
    }
    await new Promise((r) => setTimeout(r, 0))
  })
  // 60 MessageChannel messages (how WebSocket/EventSource messages arrive: one task each).
  await probe('messageTasks60', async () => {
    let { port1, port2 } = new MessageChannel()
    await new Promise<void>((resolve) => {
      let n = 0
      port1.addEventListener('message', () => {
        mutateCells(1)
        void controller!.rawUpdate()
        if (++n === 60) resolve()
      })
      port1.start()
      for (let i = 0; i < 60; i++) port2.postMessage(i)
    })
    await new Promise((r) => setTimeout(r, 0))
    port1.close()
  })
  // Mitigation: the same 60-message burst, but updates coalesced to one per animation frame.
  await probe('messageTasks60RafCoalesced', async () => {
    let { port1, port2 } = new MessageChannel()
    let frameRequested = false
    await new Promise<void>((resolve) => {
      let n = 0
      port1.addEventListener('message', () => {
        mutateCells(1)
        if (!frameRequested) {
          frameRequested = true
          requestAnimationFrame(() => {
            frameRequested = false
            void controller!.rawUpdate()
          })
        }
        if (++n === 60) resolve()
      })
      port1.start()
      for (let i = 0; i < 60; i++) port2.postMessage(i)
    })
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  })
  return {
    bursts,
    awaited60StepsCompleted,
    awaited60NextTaskUpdateResolves: recovered,
    awaited60LoopFinishedAfterThat,
    awaited60DomMatchesAfterSettle,
  }
}

/** data-rmx-preserve-dom check: does a parent re-render clobber imperatively painted rows? */
async function preserveCheck(): Promise<Record<'imperative' | 'imperative-preserve', PreserveResult>> {
  let results: PreserveResult[] = []
  for (let variant of ['imperative', 'imperative-preserve'] as const) {
    mount(variant)
    await new Promise((r) => setTimeout(r, 50))
    let before = controller!.pre().children.length
    await controller!.rawUpdate()
    await controller!.rawUpdate()
    let pre = controller!.pre()
    results.push({
      rowsBefore: before,
      rowsAfterTwoRerenders: pre.children.length,
      attributeKept: pre.hasAttribute('data-rerenders') ? pre.getAttribute('data-rerenders') : null,
      samePreNode: pre === document.querySelector('pre.screen'),
    })
  }
  return { imperative: results[0]!, 'imperative-preserve': results[1]! }
}

const api: BenchApi = { run, cascade, preserveCheck, ready: true }
window.__bench = api
