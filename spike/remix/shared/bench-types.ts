// Result shapes for probe 3, shared by the bench page, its driver and the table printer.
export type Variant = 'unkeyed' | 'keyed' | 'imperative'

export interface RunOptions {
  variant: Variant
  hz: number
  durationMs: number
  cellsPerTick?: number
  fullReplaceEveryMs?: number
}

export interface Summary {
  n: number
  mean: number
  p50: number
  p95: number
  max: number
}

export interface GuardHits {
  warn: number
  error: number
  messages: string[]
}

export interface RunStats {
  variant: Variant
  hz: number
  durationMs: number
  rows: number
  spans: number
  mountMs: number
  cellUpdateMs: Summary
  fullReplaceMs: Summary
  forcedLayoutMs: Summary
  parseMs: Summary
  frames: { count: number; over50ms: number; p95: number; max: number }
  loafOver50ms: number | null
  skippedTicks: number
  screenHeightPx: number
  domMatchesModel: boolean
  guard: GuardHits
}

export interface BurstResult {
  ms: number
  hungOnPendingUpdatePromise: boolean
  guardWarn: number
  guardError: number
  firstMessage: string | null
  domMatchesModelAfter: boolean
  domMatchesModel50msLater: boolean
}

export interface CascadeResult {
  bursts: Record<string, BurstResult>
  awaited60StepsCompleted: number
  awaited60NextTaskUpdateResolves: boolean
  awaited60LoopFinishedAfterThat: number
  awaited60DomMatchesAfterSettle: boolean
}

export interface PreserveResult {
  rowsBefore: number
  rowsAfterTwoRerenders: number
  attributeKept: string | null
  samePreNode: boolean
}

export interface BenchApi {
  ready: true
  run(options: RunOptions): Promise<RunStats>
  cascade(): Promise<CascadeResult>
  preserveCheck(): Promise<Record<'imperative' | 'imperative-preserve', PreserveResult>>
}

export interface BenchReport {
  browser: string
  version: string
  durationMs: number
  runs: Array<RunStats & { throttle: number }>
  cascade?: CascadeResult
  preserve?: Record<string, PreserveResult>
  pageErrors: string[]
}
