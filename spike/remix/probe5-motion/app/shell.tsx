import type { Handle, RemixNode } from 'remix/component'
import { probe, note, now, type VtMode, type VtRecord } from './probe.ts'

// ---- Q9: the header clock, a component with its own handle ------------------------------------

let clockHandle: Handle | undefined
let clockTimer = 0
let clockText = '--'

export const clock = {
  start(intervalMs: number): void {
    clearInterval(clockTimer)
    clockTimer = window.setInterval(() => {
      clockText = String(Math.round(now()))
      void clockHandle?.update()
    }, intervalMs)
  },
  stop(): void {
    clearInterval(clockTimer)
    clockTimer = 0
  },
  /** One timed tick: the clock's own handle.update(), nothing else. */
  tick(): Promise<AbortSignal> {
    if (!clockHandle) throw new Error('clock not mounted')
    clockText = String(Math.round(now()))
    return clockHandle.update()
  },
}

function Clock(handle: Handle) {
  clockHandle = handle
  return () => {
    probe.clock.renders++
    return (
      <span class="clock" data-testid="clock">
        {clockText}
      </span>
    )
  }
}

// ---- Q4: the view-transition seam -------------------------------------------------------------

/** The router middleware awaits this so the DOM changes only after the old snapshot exists. */
let vtGate: Promise<void> | null = null
let lastVt: ViewTransition | null = null

export function currentVtGate(): Promise<void> | null {
  return vtGate
}

export function currentViewTransition(): ViewTransition | null {
  return lastVt
}

function currentRoute(): string | null {
  return document.querySelector('main')?.getAttribute('data-route') ?? null
}

async function settle(promise: Promise<void>, record: VtRecord, field: 'finished' | 'updateCallbackDone' | 'ready') {
  try {
    await promise
    record[field] = `ok @${now()}`
  } catch (error) {
    record[field] = error instanceof Error ? `rejected @${now()}: ${error.name}: ${error.message}` : `rejected @${now()}`
  }
}

function startViewTransition(mode: VtMode, top: EventTarget): void {
  if (!('startViewTransition' in document)) {
    note('vt: document.startViewTransition missing')
    return
  }
  let record: VtRecord = {
    mode,
    startedAt: now(),
    routeAtStart: currentRoute(),
    routeAtCallback: null,
    callbackAt: null,
    doneAt: null,
    finished: 'pending',
    updateCallbackDone: 'pending',
    ready: 'pending',
  }
  probe.vt.push(record)

  if (mode === 'naive') {
    // Exactly the seam from the brief: wait for reloadComplete inside the update callback.
    lastVt = document.startViewTransition(() => {
      record.callbackAt = now()
      record.routeAtCallback = currentRoute()
      return new Promise<void>((resolve) => {
        top.addEventListener(
          'reloadComplete',
          () => {
            record.doneAt = now()
            resolve()
          },
          { once: true },
        )
      })
    })
  } else {
    // Gated: listen for reloadComplete now, and hold the router until the old snapshot is taken.
    let done = Promise.withResolvers<void>()
    let captured = Promise.withResolvers<void>()
    top.addEventListener(
      'reloadComplete',
      () => {
        record.doneAt = now()
        done.resolve()
      },
      { once: true },
    )
    vtGate = captured.promise
    lastVt = document.startViewTransition(() => {
      record.callbackAt = now()
      record.routeAtCallback = currentRoute()
      captured.resolve()
      return done.promise
    })
    // A skipped transition still runs the callback, but never leave the router waiting.
    setTimeout(() => captured.resolve(), 500)
    void lastVt.finished.finally(() => {
      if (vtGate === captured.promise) vtGate = null
    })
  }
  void settle(lastVt.ready, record, 'ready')
  void settle(lastVt.updateCallbackDone, record, 'updateCallbackDone')
  void settle(lastVt.finished, record, 'finished')
}

// ---- Q2/Q3: the module-scope shell ------------------------------------------------------------

type ShellProps = { url: URL; children?: RemixNode }
let shellHandle: Handle<ShellProps> | undefined

/** Q9: re-render the shell itself. */
export function updateShell(): Promise<AbortSignal> {
  if (!shellHandle) throw new Error('shell not mounted')
  return shellHandle.update()
}

export function Shell(handle: Handle<ShellProps>) {
  probe.shell.setups++
  shellHandle = handle
  let pending = false
  let top = handle.frames.top

  top.addEventListener(
    'reloadStart',
    () => {
      probe.nav.push({ type: 'reloadStart', t: now(), frameSrc: top.src, location: location.href })
      if (probe.flags.progress) {
        pending = true
        void handle.update()
      }
      if (probe.flags.vt !== 'off') startViewTransition(probe.flags.vt, top)
    },
    { signal: handle.signal },
  )
  top.addEventListener(
    'reloadComplete',
    () => {
      probe.nav.push({ type: 'reloadComplete', t: now(), frameSrc: top.src, location: location.href })
      if (pending) {
        pending = false
        void handle.update()
      }
    },
    { signal: handle.signal },
  )

  return () => {
    probe.shell.renders++
    return (
      <div class="app">
        <header data-testid="header">
          <a href="/" class="app-title" data-testid="home-link">
            Collie
          </a>
          <Clock />
          <nav>
            <a href="/list" data-testid="nav-list">
              list
            </a>
            <a href="/pane/1" data-testid="nav-pane-1">
              p1
            </a>
            <a href="/pane/2" data-testid="nav-pane-2">
              p2
            </a>
          </nav>
        </header>
        <div class="progress" data-testid="progress" data-active={pending ? 'true' : 'false'} />
        <main data-route={handle.props.url.pathname}>{handle.props.children}</main>
      </div>
    )
  }
}
