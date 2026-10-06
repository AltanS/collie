// Q5: keyed reorder against running CSS transitions, then the same with animateLayout (FLIP).
import { ref, type Handle } from 'remix/component'
import { animateLayout, spring } from '@remix-run/ui/animation'
import { nextFrame, round2, stats, wait } from '../probe.ts'

export type ReorderMode = 'css' | 'flip' | 'plain'

/** Deterministic shuffle, so every run moves the same rows. */
function shuffled(ids: number[], seed: number): number[] {
  let result = [...ids]
  let state = seed
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648
    let other = state % (index + 1)
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function translateX(element: Element): number {
  let matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
  return Math.round(matrix.m41 * 10) / 10
}

const layoutSpring = spring({ duration: 600, bounce: 0.2 })

interface Lab {
  shuffle(): Promise<number>
  toggleShift(): Promise<void>
  list(): HTMLElement
}

let lab: Lab | undefined

function mounted(): Lab {
  if (!lab) throw new Error('reorder lab not mounted')
  return lab
}

export function ReorderLab(handle: Handle<{ n: number; mode: ReorderMode }>) {
  let order = Array.from({ length: handle.props.n }, (_, index) => index)
  let shifted = false
  let seed = 7
  let listNode: HTMLElement | undefined
  lab = {
    async shuffle() {
      seed++
      order = shuffled(order, seed)
      let start = performance.now()
      await handle.update()
      return performance.now() - start
    },
    async toggleShift() {
      shifted = !shifted
      await handle.update()
    },
    list() {
      if (!listNode) throw new Error('list not committed')
      return listNode
    },
  }
  return () => {
    let { mode } = handle.props
    return (
      <ul
        class={`reorder reorder-${mode}`}
        data-testid="reorder"
        mix={[
          ref((node) => {
            listNode = node
          }),
        ]}
      >
        {order.map((id) => (
          <li
            key={id}
            data-id={String(id)}
            class={shifted ? 'r-row shifted' : 'r-row'}
            mix={[mode === 'flip' && animateLayout({ ...layoutSpring, size: false })]}
          >
            Row {id}
          </li>
        ))}
      </ul>
    )
  }
}

/** Moved rows are the ones the reconciler detached and re-inserted. */
function observeMoves(list: HTMLElement): () => Set<string> {
  let moved = new Set<string>()
  let observer = new MutationObserver((records) => {
    for (let record of records) {
      for (let node of record.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.id) moved.add(node.dataset.id)
      }
    }
  })
  observer.observe(list, { childList: true })
  return () => {
    for (let record of observer.takeRecords()) {
      for (let node of record.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.id) moved.add(node.dataset.id)
      }
    }
    observer.disconnect()
    return moved
  }
}

function bump(map: Map<string, number>, event: Event): void {
  if (!(event.target instanceof HTMLElement) || !event.target.dataset.id) return
  map.set(event.target.dataset.id, (map.get(event.target.dataset.id) ?? 0) + 1)
}

function average(map: Map<string, number>, group: string[]): number {
  return Math.round((group.reduce((total, id) => total + (map.get(id) ?? 0), 0) / Math.max(1, group.length)) * 10) / 10
}

function sumAll(map: Map<string, number>): number {
  return [...map.values()].reduce((a, b) => a + b, 0)
}

function countTransitions(list: HTMLElement) {
  let counts = { run: new Map<string, number>(), end: new Map<string, number>(), cancel: new Map<string, number>() }
  let controller = new AbortController()
  list.addEventListener('transitionrun', (event) => bump(counts.run, event), { signal: controller.signal })
  list.addEventListener('transitionend', (event) => bump(counts.end, event), { signal: controller.signal })
  list.addEventListener('transitioncancel', (event) => bump(counts.cancel, event), { signal: controller.signal })
  return { counts, stop: () => controller.abort() }
}

function sum(map: Map<string, number>, ids: Iterable<string>): number {
  let total = 0
  for (let id of ids) total += map.get(id) ?? 0
  return total
}

export const reorderLab = {
  /** One shot: start a 1000 ms transform transition on every row, reorder 300 ms into it. */
  async measureCssCancel() {
    let { list, toggleShift, shuffle } = mounted()
    let rows = () => [...list().querySelectorAll<HTMLElement>('li')]
    let { counts, stop } = countTransitions(list())
    await toggleShift()
    await wait(300)
    let before = new Map(rows().map((row) => [row.dataset.id ?? '', translateX(row)]))
    let moves = observeMoves(list())
    let cost = await shuffle()
    let moved = moves()
    let after = new Map(rows().map((row) => [row.dataset.id ?? '', translateX(row)]))
    await wait(1000)
    stop()
    let ids = [...before.keys()]
    let stable = ids.filter((id) => !moved.has(id))
    let movedIds = [...moved]
    return {
      rows: ids.length,
      movedRows: movedIds.length,
      stableRows: stable.length,
      reorderCostMs: round2(cost),
      moved: {
        translateXBefore: average(before, movedIds),
        translateXRightAfter: average(after, movedIds),
        transitionend: sum(counts.end, movedIds),
        transitioncancel: sum(counts.cancel, movedIds),
      },
      stable: {
        translateXBefore: average(before, stable),
        translateXRightAfter: average(after, stable),
        transitionend: sum(counts.end, stable),
        transitioncancel: sum(counts.cancel, stable),
      },
      finalTranslateX: 40,
    }
  },

  /** Ten rounds: flip the transform every 500 ms and reorder 250 ms into each transition. */
  async measureCssLoop(rounds: number) {
    let { list, toggleShift, shuffle } = mounted()
    let { counts, stop } = countTransitions(list())
    let movedTotal = 0
    for (let round = 0; round < rounds; round++) {
      await toggleShift()
      await wait(250)
      let moves = observeMoves(list())
      await shuffle()
      movedTotal += moves().size
      await wait(250)
    }
    await wait(1100)
    stop()
    return {
      rounds,
      rowMovesTotal: movedTotal,
      transitionrun: sumAll(counts.run),
      transitionend: sumAll(counts.end),
      transitioncancel: sumAll(counts.cancel),
    }
  },

  /**
   * Reorder every 500 ms and follow three rows on screen every frame. Per round, the largest
   * single-frame step of a row is divided by the layout distance that row travels: 1.0 means it
   * teleported in one frame, a small ratio means it glided.
   */
  async measureMotion(rounds: number) {
    let { list, shuffle } = mounted()
    let tracked = ['0', '1', '2'].map((id) => list().querySelector<HTMLElement>(`li[data-id="${id}"]`))
    let visual = () => tracked.map((row) => row?.getBoundingClientRect().top ?? 0)
    let layout = () => tracked.map((row) => row?.offsetTop ?? 0)
    let frames: number[] = []
    let roundSteps: number[][] = []
    let last = visual()
    let sampling = { running: true, round: -1 }
    let lastFrame = performance.now()
    let sampler = (async () => {
      while (sampling.running) {
        let time = await nextFrame()
        frames.push(time - lastFrame)
        lastFrame = time
        let tops = visual()
        let steps = roundSteps[sampling.round]
        for (let index = 0; index < tops.length; index++) {
          if (steps) steps[index] = Math.max(steps[index], Math.abs(tops[index] - last[index]))
        }
        last = tops
      }
    })()
    let costs: number[] = []
    let ratios: number[] = []
    for (let round = 0; round < rounds; round++) {
      let from = layout()
      roundSteps[round] = [0, 0, 0]
      sampling.round = round
      costs.push(await shuffle())
      let to = layout()
      await wait(500)
      for (let index = 0; index < from.length; index++) {
        let distance = Math.abs(to[index] - from[index])
        if (distance > 0) ratios.push(roundSteps[round][index] / distance)
      }
    }
    await wait(700)
    sampling.running = false
    await sampler
    return {
      rounds,
      reorderCostMs: stats(costs),
      maxStepOverDistance: round2(Math.max(0, ...ratios)),
      medianStepOverDistance: stats(ratios).p50,
      frameMs: stats(frames),
      framesOver50ms: frames.filter((ms) => ms > 50).length,
    }
  },
}
