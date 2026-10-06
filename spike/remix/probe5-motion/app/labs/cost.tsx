// Q9: where must state live? 200 row components under the shell; who re-renders on whose update?
import type { Handle } from 'remix/component'
import { probe, stats, wait } from '../probe.ts'
import { clock, updateShell } from '../shell.tsx'

function Row(handle: Handle<{ id: number }>) {
  return () => {
    probe.rows.renders++
    return <li class="c-row">row {handle.props.id}</li>
  }
}

const ROWS = Array.from({ length: 200 }, (_, index) => index)

export function CostLab() {
  return () => (
    <ul class="page cost" data-testid="cost">
      {ROWS.map((id) => (
        <Row key={id} id={id} />
      ))}
    </ul>
  )
}

export const costLab = {
  async clockOnly(durationMs: number) {
    let rowsBefore = probe.rows.renders
    let clockBefore = probe.clock.renders
    let shellBefore = probe.shell.renders
    let costs: number[] = []
    for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
      let start = performance.now()
      await clock.tick()
      costs.push(performance.now() - start)
      await wait(100)
    }
    return {
      ticks: costs.length,
      flushMs: stats(costs),
      clockRenders: probe.clock.renders - clockBefore,
      rowRenders: probe.rows.renders - rowsBefore,
      shellRenders: probe.shell.renders - shellBefore,
    }
  },

  async shellUpdates(times: number) {
    let rowsBefore = probe.rows.renders
    let clockBefore = probe.clock.renders
    let costs: number[] = []
    for (let index = 0; index < times; index++) {
      let start = performance.now()
      await updateShell()
      costs.push(performance.now() - start)
      await wait(100)
    }
    return {
      shellUpdates: times,
      rowRenders: probe.rows.renders - rowsBefore,
      clockRenders: probe.clock.renders - clockBefore,
      flushMs: stats(costs),
    }
  },
}
