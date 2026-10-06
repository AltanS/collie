// Q6: animateEntrance / animateExit on a bottom sheet, a toast and keyed list rows.
import type { Handle } from 'remix/component'
import { animateEntrance, animateExit, spring, type SpringPreset } from '@remix-run/ui/animation'
import { nextFrame, wait } from '../probe.ts'

type Kind = 'sheet' | 'toast'

interface Lab {
  set(kind: Kind, open: boolean): Promise<void>
  /** Re-renders: a node exits with the config from the last render that showed it. */
  setPreset(preset: SpringPreset): Promise<void>
  removeRow(id: number): Promise<void>
  restoreRow(id: number): Promise<void>
  root(): HTMLElement
}

let lab: Lab | undefined

function mounted(): Lab {
  if (!lab) throw new Error('motion lab not mounted')
  return lab
}

const ALL_ROWS = [1, 2, 3, 4, 5]

export function MotionLab(handle: Handle) {
  let preset: SpringPreset = 'snappy'
  let open = { sheet: false, toast: false }
  let rows = [...ALL_ROWS]
  let rootNode: HTMLElement | undefined
  lab = {
    async set(kind, value) {
      open[kind] = value
      await handle.update()
    },
    async setPreset(value) {
      preset = value
      await handle.update()
    },
    async removeRow(id) {
      rows = rows.filter((row) => row !== id)
      await handle.update()
    },
    async restoreRow(id) {
      rows = ALL_ROWS.filter((row) => rows.includes(row) || row === id)
      await handle.update()
    },
    root() {
      rootNode ??= document.querySelector<HTMLElement>('[data-testid="motion"]') ?? undefined
      if (!rootNode) throw new Error('motion root missing')
      return rootNode
    },
  }
  return () => {
    let motion = spring(preset)
    return (
      <section class="page" data-testid="motion">
        <ul class="m-rows" data-testid="m-rows">
          {rows.map((id) => (
            <li key={id} data-id={String(id)} mix={[animateExit({ opacity: 0, transform: 'scale(0.96)', ...motion })]}>
              Row {id}
            </li>
          ))}
        </ul>
        {open.toast && (
          <div
            key="toast"
            class="toast"
            data-testid="toast"
            mix={[
              animateEntrance({ opacity: 0, transform: 'translateY(8px)', ...motion }),
              animateExit({ opacity: 0, transform: 'translateY(8px)', ...motion }),
            ]}
          >
            Saved
          </div>
        )}
        {open.sheet && (
          <div
            key="sheet"
            class="sheet"
            data-testid="sheet"
            mix={[
              animateEntrance({ transform: 'translateY(100%)', ...motion }),
              animateExit({ transform: 'translateY(100%)', ...motion }),
            ]}
          >
            Bottom sheet
          </div>
        )}
      </section>
    )
  }
}

interface Sample {
  t: number
  opacity: number
  translateY: number
}

function sample(node: HTMLElement, start: number): Sample {
  let style = getComputedStyle(node)
  let matrix = new DOMMatrixReadOnly(style.transform)
  return {
    t: Math.round(performance.now() - start),
    opacity: Math.round(Number(style.opacity) * 1000) / 1000,
    translateY: Math.round(matrix.m42 * 10) / 10,
  }
}

/** Polls every frame until the node leaves the DOM; a MutationObserver stamps the removal. */
async function followExit(node: HTMLElement, start: number) {
  let parent = node.parentElement
  let removedAt: number | null = null
  let observer = new MutationObserver((records) => {
    for (let record of records) {
      for (let removed of record.removedNodes) if (removed === node) removedAt = performance.now() - start
    }
  })
  if (parent) observer.observe(parent, { childList: true })
  let samples: Sample[] = []
  let deadline = start + 3000
  while (node.isConnected && performance.now() < deadline) {
    samples.push(sample(node, start))
    await nextFrame()
  }
  observer.disconnect()
  return { removedAtMs: removedAt === null ? null : Math.round(removedAt), samples }
}

async function entranceTiming(node: HTMLElement) {
  let animation = node.getAnimations()[0]
  if (!animation) return { animated: false, durationMs: 0, finishedAfterMs: 0 }
  let start = performance.now()
  await animation.finished.catch(() => undefined)
  return {
    animated: true,
    durationMs: Math.round(Number(animation.effect?.getComputedTiming().duration ?? 0)),
    finishedAfterMs: Math.round(performance.now() - start),
  }
}

export const motionLab = {
  async exit(kind: Kind, preset: SpringPreset) {
    let { set, setPreset, root } = mounted()
    await setPreset(preset)
    await set(kind, true)
    let node = root().querySelector<HTMLElement>(`[data-testid="${kind}"]`)
    if (!node) throw new Error(`${kind} not rendered`)
    let entrance = await entranceTiming(node)
    await wait(50)
    let start = performance.now()
    await set(kind, false)
    let stillInDomAfterCommit = node.isConnected
    let followed = await followExit(node, start)
    let last = followed.samples.at(-1)
    return {
      kind,
      preset,
      springDurationMs: spring(preset).duration,
      entrance,
      stillInDomAfterCommit,
      removedAtMs: followed.removedAtMs,
      exitFrames: followed.samples.length,
      lastSampleBeforeRemoval: last,
    }
  },

  async rowExit(preset: SpringPreset) {
    let { setPreset, removeRow, restoreRow, root } = mounted()
    await setPreset(preset)
    let node = root().querySelector<HTMLElement>('li[data-id="2"]')
    if (!node) throw new Error('row 2 missing')
    let start = performance.now()
    await removeRow(2)
    let followed = await followExit(node, start)
    await restoreRow(2)
    await wait(500)
    return {
      preset,
      springDurationMs: spring(preset).duration,
      removedAtMs: followed.removedAtMs,
      lastSampleBeforeRemoval: followed.samples.at(-1),
    }
  },

  /** Remove row 3, bring it back 60 ms later, before its exit can finish. */
  async reclaim(preset: SpringPreset) {
    let { setPreset, removeRow, restoreRow, root } = mounted()
    await setPreset(preset)
    let list = root().querySelector<HTMLElement>('[data-testid="m-rows"]')
    let original = list?.querySelector<HTMLElement>('li[data-id="3"]')
    if (!list || !original) throw new Error('row 3 missing')
    let start = performance.now()
    let removedNodes = 0
    let addedNodes = 0
    let observer = new MutationObserver((records) => {
      for (let record of records) {
        removedNodes += record.removedNodes.length
        addedNodes += record.addedNodes.length
      }
    })
    observer.observe(list, { childList: true })
    await removeRow(3)
    await wait(60)
    let midExit = sample(original, start)
    await restoreRow(3)
    let copiesRightAfter = list.querySelectorAll('li[data-id="3"]').length
    let samples: Sample[] = []
    while (performance.now() - start < 700) {
      samples.push(sample(original, start))
      await nextFrame()
    }
    observer.disconnect()
    let current = list.querySelector<HTMLElement>('li[data-id="3"]')
    return {
      preset,
      midExitSample: midExit,
      copiesRightAfterRestore: copiesRightAfter,
      sameNodeReclaimed: current === original,
      originalStillConnected: original.isConnected,
      domOrder: [...list.querySelectorAll<HTMLElement>('li')].map((row) => row.dataset.id).join(','),
      childListRemovals: removedNodes,
      childListAdditions: addedNodes,
      minOpacityAfterRestore: Math.min(...samples.map((s) => s.opacity)),
      finalSample: samples.at(-1),
    }
  },
}
