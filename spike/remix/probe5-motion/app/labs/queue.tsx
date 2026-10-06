// Q1: does handle.queueTask(fn) run without handle.update()? And in which order with it?
import { createMixin, on, ref, type Handle } from 'remix/component'
import { now } from '../probe.ts'

interface EventLog {
  log: string[]
}

export const queueLab: EventLog = { log: [] }

function entry(text: string): void {
  queueLab.log.push(`${now()} ${text}`)
}

/** Logs the mixin lifecycle of the host, so "commit" has a name in the log. */
const commitProbe = createMixin<HTMLElement>((handle) => {
  handle.addEventListener('beforeUpdate', () => entry('mixin beforeUpdate'))
  handle.addEventListener('commit', () => entry('mixin commit'))
})

export function QueueLab(handle: Handle) {
  let renders = 0
  let host: HTMLElement | undefined

  function task(label: string) {
    return (signal: AbortSignal) => entry(`task ${label}: dom shows render#${host?.dataset.renders} aborted=${signal.aborted}`)
  }

  function markTurn(): void {
    queueMicrotask(() => entry('microtask queued by click'))
    setTimeout(() => entry('setTimeout(0) queued by click'), 0)
  }

  return () => {
    renders++
    entry(`render#${renders}`)
    return (
      <section
        class="page"
        data-testid="queue"
        data-renders={String(renders)}
        mix={[
          ref((node) => {
            host = node
          }),
          commitProbe(),
        ]}
      >
        <button
          type="button"
          data-testid="q-task-only"
          mix={[
            on('click', () => {
              entry('click: queueTask only')
              handle.queueTask(task('A (no update)'))
              markTurn()
            }),
          ]}
        >
          queueTask only
        </button>
        <button
          type="button"
          data-testid="q-update-only"
          mix={[
            on('click', () => {
              entry('click: update only')
              void handle.update().then(() => entry('update() promise resolved'))
              markTurn()
            }),
          ]}
        >
          update only
        </button>
        <button
          type="button"
          data-testid="q-task-update"
          mix={[
            on('click', () => {
              entry('click: update() then queueTask')
              void handle.update().then(() => entry('update() promise resolved'))
              handle.queueTask(task('B (with update)'))
              markTurn()
            }),
          ]}
        >
          update + queueTask
        </button>
        <span data-testid="renders">{String(renders)}</span>
      </section>
    )
  }
}
