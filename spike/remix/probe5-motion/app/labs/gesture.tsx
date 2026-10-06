// Q10: long-press and horizontal-swipe event mixins, consumed by a parent through bubbling.
import { createMixin, css, on, type Handle } from 'remix/component'
import { now } from '../probe.ts'

export const longPressType = 'app:longpress' as const
export const swipeType = 'app:swipe' as const

export class LongPressEvent extends Event {
  pointerType: string
  heldMs: number
  constructor(pointerType: string, heldMs: number) {
    super(longPressType, { bubbles: true })
    this.pointerType = pointerType
    this.heldMs = heldMs
  }
}

export class SwipeEvent extends Event {
  direction: 'left' | 'right'
  dx: number
  /** px per ms over the last 100 ms of the drag. */
  velocityX: number
  pointerType: string
  constructor(direction: 'left' | 'right', dx: number, velocityX: number, pointerType: string) {
    super(swipeType, { bubbles: true })
    this.direction = direction
    this.dx = dx
    this.velocityX = velocityX
    this.pointerType = pointerType
  }
}

declare global {
  interface HTMLElementEventMap {
    [longPressType]: LongPressEvent
    [swipeType]: SwipeEvent
  }
}

interface EventLog {
  log: string[]
}

export const gestureLab: EventLog = { log: [] }

function entry(text: string): void {
  gestureLab.log.push(`${now()} ${text}`)
}

const MOVE_TOLERANCE_PX = 10

export const longPress = createMixin<HTMLElement, [delayMs?: number]>((handle) => {
  let node: HTMLElement | undefined
  let timer = 0
  let startX = 0
  let startY = 0
  let startedAt = 0

  handle.addEventListener('insert', (event) => {
    node = event.node
  })
  handle.addEventListener('remove', () => clearTimeout(timer))

  function cancel(reason: string): void {
    if (timer === 0) return
    clearTimeout(timer)
    timer = 0
    entry(`longpress cancelled by ${reason}`)
  }

  return (delayMs = 500) => (
    <handle.element
      mix={[
        on('pointerdown', (event) => {
          if (!event.isPrimary || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          startX = event.clientX
          startY = event.clientY
          startedAt = event.timeStamp
          let pointerType = event.pointerType
          clearTimeout(timer)
          timer = window.setTimeout(() => {
            timer = 0
            node?.dispatchEvent(new LongPressEvent(pointerType, Math.round(performance.now() - startedAt)))
          }, delayMs)
        }),
        on('pointermove', (event) => {
          if (timer === 0) return
          if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) cancel('move')
        }),
        on('pointerup', () => cancel('pointerup')),
        on('pointercancel', () => cancel('pointercancel')),
        on('pointerleave', () => {
          entry('longpress host saw pointerleave')
          cancel('pointerleave')
        }),
        on('contextmenu', (event) => event.preventDefault()),
      ]}
    />
  )
})

const swipeSurface = css({ touchAction: 'pan-y' })

export const swipe = createMixin<HTMLElement, [thresholdPx?: number]>((handle) => {
  let tracking = false
  let startX = 0
  let samples: Array<{ x: number; t: number }> = []

  function reset(target: HTMLElement): void {
    tracking = false
    samples = []
    target.style.transform = ''
  }

  return (thresholdPx = 60) => (
    <handle.element
      mix={[
        swipeSurface,
        on('pointerdown', (event) => {
          if (!event.isPrimary) return
          event.currentTarget.setPointerCapture(event.pointerId)
          tracking = true
          startX = event.clientX
          samples = [{ x: event.clientX, t: event.timeStamp }]
        }),
        on('pointermove', (event) => {
          if (!tracking) return
          samples.push({ x: event.clientX, t: event.timeStamp })
          while (samples.length > 2 && event.timeStamp - samples[0].t > 100) samples.shift()
          event.currentTarget.style.transform = `translateX(${event.clientX - startX}px)`
        }),
        on('pointerup', (event) => {
          if (!tracking) return
          let dx = event.clientX - startX
          let first = samples[0]
          let dt = Math.max(1, event.timeStamp - first.t)
          let velocityX = (event.clientX - first.x) / dt
          let target = event.currentTarget
          reset(target)
          if (Math.abs(dx) < thresholdPx && Math.abs(velocityX) < 0.5) {
            entry(`swipe below threshold dx=${dx}`)
            return
          }
          target.dispatchEvent(new SwipeEvent(dx < 0 ? 'left' : 'right', dx, Math.round(velocityX * 1000) / 1000, event.pointerType))
        }),
        on('pointercancel', (event) => {
          entry(`swipe pointercancel (${event.pointerType})`)
          reset(event.currentTarget)
        }),
      ]}
    />
  )
})

export function GestureLab(handle: Handle) {
  let longPresses = 0
  let swipes = 0
  return () => (
    <section
      class="page gesture"
      data-testid="gesture"
      mix={[
        on(longPressType, (event) => {
          longPresses++
          entry(`parent got ${event.type} pointerType=${event.pointerType} held=${event.heldMs}ms target=${event.target instanceof HTMLElement ? event.target.dataset.testid : '?'}`)
          void handle.update()
        }),
        on(swipeType, (event) => {
          swipes++
          entry(`parent got ${event.type} ${event.direction} dx=${event.dx} vx=${event.velocityX} pointerType=${event.pointerType}`)
          void handle.update()
        }),
      ]}
    >
      <div class="press" data-testid="press" mix={[longPress(500)]}>
        hold me
      </div>
      <div class="swipe" data-testid="swipe" mix={[swipe(60)]}>
        swipe me
      </div>
      <p>
        long presses <span data-testid="longpress-count">{String(longPresses)}</span>, swipes{' '}
        <span data-testid="swipe-count">{String(swipes)}</span>
      </p>
      <div class="tall" />
    </section>
  )
}
