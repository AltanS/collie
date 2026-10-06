// Everything the Playwright driver reads or toggles. One module-scope object, no framework state.

export type VtMode = 'off' | 'naive' | 'gated'

export interface NavEvent {
  type: 'reloadStart' | 'reloadComplete'
  t: number
  frameSrc: string
  location: string
}

export interface VtRecord {
  mode: VtMode
  startedAt: number
  /** `main[data-route]` when the update callback runs: the DOM the old snapshot was taken from. */
  routeAtCallback: string | null
  routeAtStart: string | null
  callbackAt: number | null
  doneAt: number | null
  finished: string
  updateCallbackDone: string
  ready: string
}

interface ProbeState {
  t0: number
  log: string[]
  shell: { setups: number; renders: number }
  clock: { renders: number }
  pane: { setups: number; renders: number }
  list: { setups: number; renders: number }
  rows: { renders: number }
  nav: NavEvent[]
  vt: VtRecord[]
  flags: { progress: boolean; vt: VtMode; paneKeyed: boolean; restoreScroll: boolean; listDelayMs: number }
}

export const probe: ProbeState = {
  t0: performance.now(),
  log: [],
  shell: { setups: 0, renders: 0 },
  clock: { renders: 0 },
  pane: { setups: 0, renders: 0 },
  list: { setups: 0, renders: 0 },
  rows: { renders: 0 },
  nav: [],
  vt: [],
  flags: {
    progress: true,
    vt: 'off',
    paneKeyed: false,
    restoreScroll: false,
    listDelayMs: 300,
  },
}

export function now(): number {
  return Math.round((performance.now() - probe.t0) * 100) / 100
}

export function note(entry: string): void {
  probe.log.push(`${now()} ${entry}`)
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** p50 / p95 / max of a list of timings, rounded to 0.01. */
export function stats(values: number[]) {
  let sorted = values.toSorted((a, b) => a - b)
  let pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { n: values.length, p50: round2(pick(0.5)), p95: round2(pick(0.95)), max: round2(sorted.at(-1) ?? 0) }
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}
