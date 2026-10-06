// The page hooks the Playwright drivers read. Declared once so no driver needs a cast.
import type { BenchApi } from './bench-types.ts'

export interface SpikeApi {
  bootId: string
  routerLog: string[]
  setupCounts: { shell: number; list: number; pane: number }
  hasNavigationApi: boolean
  ready(): Promise<void>
  lock(): void
  unlock(): Promise<void>
}

declare global {
  interface Window {
    __spike?: SpikeApi
    __bench?: BenchApi
  }
}
