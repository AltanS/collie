# REMIX3.md: the house rules for the Remix 3 shell

Read this before you write code under `web-remix/`. It is short on purpose.

## Why this file

The Remix 3 component runtime is not React. It has no hooks, no memo and no bail-out.
It drops updates past a guard, and its docs have traps. This file states how Collie uses it.
It does not replace `DESIGN.md`. It says how each `DESIGN.md` rule is met in Remix terms.
Every rule names a source path. If a rule here is wrong, fix this file in the same change.

### Path prefixes

| Prefix | Means |
| --- | --- |
| `C/` | Remix monorepo `packages/component/` at commit 27bd7a4 (`docs/*.md`, `src/runtime/*.ts`) |
| `G/` | Remix monorepo `packages/remix/guides/` |
| `S/` | Remix monorepo `packages/spa/` |
| `U/` | Remix monorepo `packages/ui/src/animation/README.md` (`@remix-run/ui` 0.12.1) |
| `I/` | `web-remix/node_modules/remix/INDEX.md`, the index for the installed `remix@3.0.0` |
| `R/` | `web-remix/src/`, this shell |
| `W/` | `web/src/`, the React app, the behaviour reference |
| `D` | `DESIGN.md` at the repo root, binding on all UI |
| `SPIKE` | `spike/remix/README.md`, probes 1 to 4 |
| `P5` | `spike/remix/probe5-motion/README.md`, the motion probe |
| research note 01, 02, 03 | the deep read, the app survey and the Collie UI spec, kept in the workspace at `experiments/remix-v3/research/0N-*.md`, outside this repo |

Survey apps are named by repo and file, for example `remix-website: accordion.tsx`.

## Non-negotiables

A reviewer sends the diff back if it breaks one of these.

1. No subscription, socket, timer or store calls `handle.update()` directly; it calls `scheduleUpdate(handle)`.
2. Read changing props from `handle.props` inside render; never destructure props in setup.
3. A route whose state belongs to one entity renders with `key` set to that entity's id.
4. A component subscribes only to the stores it renders from; a parent never subscribes "so the children update".
5. Every window or document listener, timer and rAF loop ends on `handle.signal`; every async handler checks `signal.aborted` after each `await`.
6. The Shell, the header host and the Collie mark live at module scope and never remount; routes claim the header, they never draw one.
7. In-flow content appears, leaves or changes size only through `Collapse`; no bare `cond && <X />` in flow, no `hidden`.
8. Rows never move on a poll: key lists by a stable id and freeze the order until the operator taps.
9. Back goes up (ADR 0067), a sheet owns no history entry, and nothing calls `location.reload()`.
10. Reduced motion is its own path: decided in CSS first, and checked in JS before any animation starts.

## Mental model

### Setup runs once, render runs every time

- A component is a setup function that returns a render function (`C/docs/components.md`).
- Setup runs once per instance. Put state, subscriptions and stable callbacks there.
- Render runs on the first render and on every update. It must be pure: no DOM reads, no writes,
  no store writes (`G/04-rendering-ui.md`).
- An instance survives when the same function sits at the same position. A different function, or
  a different `key`, gives a new instance (`C/docs/composition.md`, "Key Prop").

### Props

- `handle.props` is one stable object. The runtime refreshes it before each render.
- Destructure inside render only. A value read in setup is frozen at the first render
  (`C/docs/components.md`, `G/04-rendering-ui.md`).
- Today `R/routes/pane/pane.tsx` reads `handle.props.paneId` and `address.get().scope` in setup.
  That is only safe because of rule 3. See "Where the current shell stands".

### `update()`

- `handle.update()` schedules one render and returns `Promise<AbortSignal>` (`C/docs/handle.md`).
- Several calls in one turn become one render, in one microtask flush (`C/src/runtime/scheduler.ts`).
- In setup it warns and does nothing. In render it throws. Before the first commit, from outside
  setup, it throws (`C/docs/handle.md`). This is why `useStore` subscribes in a `queueTask`.
- `await handle.update()` before you touch the new DOM. Do not guess with `setTimeout` or rAF
  (`C/docs/patterns.md`, "Focus Management").

### The flush order

One flush runs: renders, work tasks, focus restore, commit-phase tasks, `commit` events, then user
`queueTask` callbacks (`C/src/runtime/scheduler.ts`).

- `queueTask(task)` runs after the DOM commit and gets a signal. A raw `queueMicrotask` runs before
  the flush and sees the old DOM.
- `queueTask` only enqueues. A task queued from a click handler with no `update()` never runs until
  something renders that component again (measured 500 ms of nothing, P5 Q1). Pair it with
  `update()`: then render, commit, task, all in one microtask, in either call order (P5 Q1). A task
  queued in setup or in render runs after that render's commit.
- Do not create a flag only to react to it in a task (`C/docs/handle.md`, "Anti-patterns").

### The guard

- The scheduler counts flushes per component. It warns at 50. Past 50 in one turn it dispatches
  `handle.update() infinite loop detected` and drops the rest of that batch
  (`C/src/runtime/scheduler.ts`).
- "One turn" ends only at the next `setTimeout(0)`. A WebSocket burst, a `ReadableStream` reader with
  buffered chunks, or `while (...) await handle.update()` all count as one turn (SPIKE, "The cascade
  guard").
- A dropped update leaves the screen stale until something else updates it. The spike lost the last
  10 of 60 queued messages in both Chromium and WebKit.

### Parents always re-render children

- `diffComponent` always calls `renderComponent`. There is no memo, no `shouldUpdate`, no bail-out
  (research note 01, section 1; `C/src/runtime/component.ts`).
- So a parent's update re-renders its whole subtree. A Shell update re-renders every route.
- Make children cheap instead: derive data once per input identity in setup, as
  `R/routes/pane/pane.tsx` does with `blocks !== lastBlocks` and `R/routes/pane/terminal.tsx` does
  with `lines !== lastLines`.
- Measured: a Shell update re-renders all 200 trivial rows in 0.6 ms (p50, Chromium), a leaf clock's
  own update renders 0 rows (P5 Q9). Real rows cost more, so the rule stands: keep the Shell static.

### Where state lives

| State | Lives in | Example |
| --- | --- | --- |
| One instance's UI state (open, pending, draft text) | a `let` in setup | `R/routes/pane/composer.tsx` |
| Shared by one subtree, changes rarely | a `TypedEventTarget` model in context | the header model, below |
| App data every route reads | a module store (`R/lib/store.ts`) | `snapshot`, `config` in `R/lib/data.ts` |
| A device preference | a module store backed by `localStorage`, same keys as `W/` | `collie:dash-prefs:v1` |
| The URL's facts (scope, pane id) | the URL, read in the route action | `R/routes/pane/action.tsx` |

## State

### A `let` in setup is enough when

- Only this instance reads it, and it dies with the instance (`C/docs/patterns.md`, "Use Minimal
  Component State").
- Change it in an event handler, then call `handle.update()`. A direct call is fine here: one click is
  one update.

### A `TypedEventTarget` model in context is right when

- A subtree shares it, and the provider must not re-render on change (`C/docs/context.md`,
  "TypedEventTarget for Granular Updates").
- The provider calls `handle.context.set(model)` once in setup and never updates for it.
- Each consumer subscribes and re-renders alone. Context is keyed by the provider's function
  identity, so the provider lives at module scope.

```tsx
function HeaderProvider(handle: Handle<{ children?: RemixNode }, HeaderModel>) {
  const model = new HeaderModel();
  handle.context.set(model); // set once, never followed by update()
  return () => handle.props.children;
}

function HeaderHost(handle: Handle) {
  const model = handle.context.get(HeaderProvider);
  handle.queueTask(() => model.addEventListener("change", () => scheduleUpdate(handle), { signal: handle.signal }));
  return () => <header>{/* reads model.current */}</header>;
}
```

The upstream example calls `handle.update()` in the listener. We route it through `scheduleUpdate`
(rule 1), and we subscribe in a task because a change before the first commit would throw.

### A module store is right when

- Data outlives every component: polled data, prefs, the idle lock, the update stage.
- The survey pattern is a module with `subscribe(listener, signal)` (`remix-website:
  landing-scroll.ts:165`).
- Ours is `createStore(initial, equal)` in `R/lib/store.ts`: `get`, `set`, `update`, `subscribe`,
  `version`. `set` skips equal values, so a 304 poll wakes nobody.
- **Publish only on change; freshness is its own store.** A polled store compares by field, and a
  poll that brings the same payload keeps the HELD object (`R/lib/same.ts`: a 304, a mirror with
  the same text and revision, a snapshot that differs only in `ts`). When the bridge last answered
  is never part of a value many components read: it is `snapshotAt` (`R/lib/data.ts`), and only
  the readers that draw or act on freshness subscribe to it, with a filter in the listener (the
  connection strip while red, the stale-app watch, the pane's auto-exit proof). Counters that move
  on every poll stay out of the store too (`chatReads`, `R/routes/pane/chat-store.ts`). Before this
  rule, `at: Date.now()` in every poll woke every subscriber: 4 dashboard and about 9 pane passes
  per 14 s idle, with no DOM change (research note 05, rank 1). `e2e/pane-quiet.spec.ts` holds an
  idle pane and the dashboard at zero route renders over 10 s of identical polls.

### How our helpers map

| Helper | Does | Rule it enforces |
| --- | --- | --- |
| `createStore` | a value plus listeners, equality-gated | no wake on no change |
| `useStore(handle, store)` | subscribes after the first commit, ends on `handle.signal`, catches a missed change by version | rules 1 and 5 |
| `scheduleUpdate(handle)` | one `update()` per component per animation frame; a timer when the page is hidden or frames are held (`holdFrames`) | rule 1, the guard |
| `want(source, handle.signal)` | keeps a read on the polling beat while mounted | rule 5 |

- `useStore` is not a hook. Call it in setup only, once per store. A call in render subscribes again
  on every render.
- Change to make: `subscribe` returns an unsubscribe today. Add a `signal` argument so callers write
  `store.subscribe(fn, handle.signal)`, as the survey does, and nobody forgets the cleanup.

### The per-frame coalescer rule

Every update that a store, a socket, a stream or a timer causes goes through `scheduleUpdate`.
No exception for "it only fires once a second". The spike shows 60 coalesced messages give 0 guard
errors, and 60 direct ones drop updates (SPIKE, table "Burst of 60 updates").

A direct `handle.update()` is allowed only in an `on()` handler, for that instance's own state.

### Clocks and timers

Idle, a page should wake the main thread only when something on screen can change. Measured on
2026-10-07 (`experiments/remix-v3/bench/results/resources-2026-10-07-316e7159.md`): 435 wake-ups a
minute idle, 191 hidden, against 207 and 16 for the React shell. The chain was a clock that
published every second, five components each arming their own frame, and the runtime's guard-reset
timer after every flush.

- The shared clock (`R/lib/clock.ts`) runs only while something listens AND the page is visible.
  Hidden, it stops; visible again, it restarts from the present and notifies once.
- A store publishes only when a displayed value can change. The clock itself ticks each second
  because the cache chip's borders (`floor((expiresAt - now) / 60 s)`, cold 10 s past expiry) sit at
  each pane's own offset in the minute; a reader that needs less wakes itself less with
  `useStoreSelect(handle, store, select)`, which re-renders only when `select(value)` changed since
  its last render. `select` returns a primitive and may read `handle.props`.
- Never read the wall clock in a loop to "keep a label fresh". A reader subscribes to the clock; a
  new reader that needs another resolution gets its own store, not a faster clock.
- `scheduleUpdate` shares ONE frame (or one timer, hidden or held) per turn across all handles
  (`R/lib/store.ts`, `flush`). Each handle still coalesces to one update. The guard is per component,
  so a shared frame gives each component one cascading update, same as before.
- A new interval or `setTimeout` needs a reason in a comment and a way to stop it when hidden.

### Never

- `handle.context.set(v)` followed by `handle.update()` on the provider. It re-renders the whole
  subtree (`C/docs/component.md:635`).
- A store write inside render.
- A store per instance kept in module scope with no end. `R/lib/data.ts` `paneStores` keeps one per
  pane for the page's life on purpose; do not copy that for per-render things.
- Store state in `history.state`. The runtime overwrites it on non-traverse navigations (research
  note 01, section 7, question 3).

## Events and gestures

### `on()` semantics

- `on(type, handler, capture?)` adds one listener per element. No delegation. The third argument is
  capture only; there is no `once` and no `passive` (`C/docs/events.md`).
- The handler is swapped in place on re-render. Its signature is `(event, signal)`. The signal aborts
  when the same slot fires again or the element leaves.
- A rejected promise from a handler is not routed to the root `error` event. Catch and report it
  yourself (`R/main.tsx` only logs the runtime's own errors).
- Prefer native `<button>` and `click` (`C/docs/events.md`, "Prefer Native Activation").

### Async handlers

```tsx
on("click", async (_event, signal) => {
  pending = true;
  handle.update();
  const ok = await sendReply(target(), text, signal);
  if (signal.aborted) return; // a second tap or an unmount won
  pending = false;
  handle.update();
});
```

Pass the signal to `fetch`. Never keep manual request ids (`C/docs/events.md`, "Always Check
signal.aborted").

**A `queueTask` signal is render-scoped.** The signal a task receives is the render's own: the
component's next render for ANY reason (a store wake, a parent update, a navigation) aborts it, so an
`await` followed by `if (signal.aborted) return` drops its result whenever something re-rendered in
between (`C/src/runtime/component.ts`, `render()` calls `#abortRenderSignal()`; kody hit it three
ways, research note 07 d.1). Work that must outlive a re-render, a fetch or a timer the component
owns, uses `handle.signal` (the instance's life) and its own `AbortController` kept in setup, aborted
on `handle.signal`, with a superseding call aborting the previous one. A task that calls
`handle.update()` before its first `await` aborts itself, the next render queues another, and the
scheduler reaches its guard: set the pending UI in the render that decides to load, never in the task.
Today no `queueTask` in `R/` awaits (`git grep` it before you add the first).

### Window and document listeners

Register with `{ signal: handle.signal }` (`C/docs/handle.md`, "Native Event Listeners"). This shell
is client-only, so setup already runs in the browser and may register directly. Use a `queueTask`
only when the listener can call `update()` before the first commit. For an element listener that
needs `passive: false` (a drag), add it natively inside `ref((node, signal) => ...)` and set
`touch-action: none` on the surface (`G/07-animation.md`). `R/ui/sheet.tsx` already does this for
the pull-down.

### Child to parent

- Default: a callback prop, read at call time (`handle.props.onHold?.(...)`). `R/routes/home/agent-row.tsx`
  does this.
- A gesture mixin dispatches a bubbling, namespaced event, `app:longpress` or `app:pull`, and the
  owner listens with `on("app:longpress", ...)` (`C/docs/interactions.md`).
- Across trees, use a model in context. The handle is not an `EventTarget`.
- A parent that must reach many children per pointer move dispatches one custom DOM event downward,
  so the children do not re-render (`timeboxer: schedule-grid.tsx:105`).

### Long-press: one `createMixin`

The behaviour is `W/hooks/use-long-press.ts`: 450 ms to fire, 16 px move tolerance, `data-holding`
from 150 ms, `contextmenu` as a second trigger, the next click swallowed, a 10 ms haptic on fire.

```tsx
export const longPress = createMixin<HTMLElement>((handle) => {
  let node: HTMLElement | undefined;
  let hold: { x: number; y: number; t1: number; t2: number } | undefined;
  let fired = false;
  handle.addEventListener("insert", (e) => { node = e.node; });
  handle.addEventListener("remove", () => cancel());
  // cancel(): clear both timers, remove data-holding and the inline animation-duration
  // fire(): cancel(), fired = true, buzz(), node.dispatchEvent(new LongPressEvent())
  return () => <handle.element mix={[/* pointerdown, pointermove, pointerup/cancel/leave,
    contextmenu, click (capture: swallow when fired) */]} />;
});
```

- `pointerdown` arms two timers: 150 ms sets `data-holding` and `animation-duration: 300ms` inline;
  450 ms fires. The look comes from `W/index.css` "THE HOLD, SHOWN", already imported by
  `R/app.css`. Do not give a hold surface a look of its own (D §2).
- Keep state in the mixin's setup, not in a function called from render. Mixin setups live at module
  scope and keep a stable order in `mix` (`C/docs/mixins.md`).
- `R/lib/gestures.ts` has the mixins: `longPress`, `pull`, `swipeUp`. `R/ui/chip.tsx` uses
  `longPress`; `R/lib/long-press.ts` is the old `on()` array, still used by the home rows.
- Measured (P5 Q10): a `createMixin` hold with a bubbling `app:longpress` fires once at its mark for
  mouse in both engines and for CDP touch in Chromium. With pointer capture, `pointerleave` only
  fires after release, so a hold needs its own move tolerance. A touch drag on a `pan-y` box scrolls
  the page and sends the mixin `pointercancel`.

### Swipe and pull

- Belt vertical drag opens the pane switcher at 120 px or 0.6 px/ms, vertical only
  (`W/hooks/use-sheet-pull.ts`). Sheet pull-down closes past 90 px. Up-swipe counts at 36 px
  (`W/hooks/use-swipe.ts`).
- Write each as one mixin that tracks velocity with pointer capture, as `U/src/demos/animation/drag-release.ts`
  and `C/docs/interactions.md` "Drag Release Mixin" do, and dispatches one `app:` event on release.
- During the drag, write `transform` straight to the node. Never `update()` per pointer move.
- No pull-to-refresh. `body` keeps `overscroll-behavior-y: none`. The iOS edge swipe is the phone's
  own back and gets no animation of ours (D §12).

### Keyboard

- Native buttons and links first. `link(href)` gives a non-anchor host `role="link"` and Enter
  (`G/05-interactivity.md`, "Client navigation"). Prefer a real `<a>`.
- Composer keys live in `R/composer/keys.ts`, a pure module with tests. Keep it pure.

## Shell, header and navigation

### One Shell, at module scope

`R/router.tsx` installs `render((content, { url }) => <Shell url={url}>{content}</Shell>)`.
The Shell keeps its DOM and setup state across routes, and it re-renders on each navigation
(`S/README.md`, "Wrapping Route Content"; research note 01, section 5). This shell already follows
that, and the router lives at module scope so `remount()` in `R/main.tsx` keeps it.

- The Shell renders from the URL and the idle lock. It does not subscribe to `snapshot` or `config`.
- Route bodies of one type at one position keep their instance. Rule 3 says when to add a `key`.
- Measured (P5 Q2): Shell setup runs once per run; the header is the same node across four
  navigations and keeps attributes it does not own. Unkeyed, a same-type route body keeps its state
  across `/pane/1` to `/pane/2`; keyed, it remounts. `R/e2e/shell.spec.ts` pins the mark's node and
  its running animation across home to pane.

### The header is a claim, not a child

`W/components/app-header.tsx` is mounted once above the outlet. Routes feed it through
`<RouteHeader>` and never re-render it. In Remix there are no portals, so the header becomes a
model in context.

- `HeaderModel extends TypedEventTarget<{ change: Event }>`, provided by the Shell.
- A route claims `{ center, right, override, wordmark, width, hidden }` with an owner token, and
  releases on `handle.signal`. Last claim wins; a release of a stale owner does nothing.
- `center`, `right` and `override` carry plain data plus callbacks made once in setup, not fresh
  nodes. The model compares shallowly and dispatches `change` only on a real difference.
- A `custom` slot is compared by object identity first (`sameSlot`). To make the host redraw one,
  claim a NEW slot object with a new `rev`; writing `slot.rev = ...` on the object already claimed
  wakes nobody (Files lost its filter button that way until 2026-10-06).
- The route publishes from a `queueTask` in render, after commit. It never writes the model in
  render.

```tsx
export function PaneRoute(handle: Handle<{ paneId: string }>) {
  const header = handle.context.get(HeaderProvider);
  const owner = header.owner(handle.signal); // released on unmount
  const openMenu = () => { menuOpen = true; handle.update(); };
  return () => {
    handle.queueTask(() => owner.claim({ center: { kind: "pane", name, meta }, right: { menu: openMenu }, width: "wide" }));
    return <main>...</main>;
  };
}
```

- The host draws the Collie mark in the same position on every route. It hides the identity block
  with `invisible`, never by unmounting (`W/components/collie-home.tsx`). The mark's CSS animations
  must never restart.
- The row is `min-h-15`, never `h` (D §6). Width is column or wide, from the claim.
- `HeaderStatus` takes the title slot for 2.5 s with no animation; errors persist. It is a header
  state, not an in-flow line.

### Pending UI

- Subscribe to `handle.frames.top` `reloadStart` and `reloadComplete` in a `queueTask` with
  `{ signal: handle.signal }`. At `reloadStart`, `frame.src` is the new URL (`demos/spa:
  app-shell.tsx:14`).
- Our actions do no fetching (`R/router.tsx`), so most navigations finish in one frame. Show the busy
  bar only after 120 ms, as `W/index.css:895` does. The bar is fed by `R/lib/busy.ts`, not by
  navigation alone: every write for its whole flight, a first read past 500 ms, a poll past 6 s.
- Measured (P5 Q3): on a 300 ms route the bar is on from about 20 to 30 ms and off at 320 to 330 ms;
  on an instant route it toggles in the same millisecond and never paints. A bar inside the Shell
  costs two extra Shell renders per navigation, so it is its own component (`BusyBar`, `R/shell.tsx`).

### Navigating

- Use `navigate(href(path), { history })` from `R/lib/navigate.ts`, which is remix/component's with
  `resetScroll: false` always (see "Scroll"). `href()` in `R/routes.ts` puts the ADR 0052 mount back on.
- Down pushes. Sideways (pane to pane, tab to tab) replaces. Up steps back when the entry behind is a
  parent, else replaces onto the parent. Never push a parent (D §12, ADR 0067).
- `R/routes/pane/back.ts` already does up correctly for the pane. Lift it into one `R/lib/nav.ts`
  with `down`, `side` and `up`, reusing `W/lib/nav.ts` read-only, and use it everywhere.
- A sheet owns no history entry (D §12). Do not copy the survey's URL-driven modal
  (`remix-website: tickets-modal.tsx:96`).
- A plain `<a>` is intercepted only where the Navigation API and `NavigateEvent.sourceElement` exist.
  Without them every tap is a full reload (SPIKE, probe 4).

### Scroll

- With `resetScroll` on (the runtime's default), push and replace reset window scroll after the
  first commit, and back and forward let the browser restore it (research note 01, section 5). This
  shell turns it off on every navigation (below): there is no window scroll to reset.
- Our Shell is `h-(--app-h) overflow-hidden`, so every route scrolls an inner pane, and the runtime
  restores nothing there.
- Every inner scroller keeps its own spot, keyed by route and entity, as `R/screen/follow.ts`
  (`recallSpot`, `rememberSpot`) does for the terminal. Restore in a `queueTask` after the first
  commit. The dashboard and Settings have no spot memory yet.
- Measured (P5 Q8): the runtime restores nothing inside; a module `Map` keyed by
  `navigation.currentEntry.key`, restored in `queueTask`, lands back on the same row in both engines,
  and a fresh push starts at the top. `R/lib/scroll.ts` `scrollMemory()` is that idiom as a mixin.
- Every `navigate()` passes `resetScroll: false`, through `R/lib/navigate.ts` (import `navigate`
  from there, never from `remix/component`). Left on, the runtime guards a window scroll this Shell
  never does: a forced layout and an `adoptedStyleSheets` swap on each back move, an
  `overflow-anchor` sheet on each push (research note 06, item 1). A back move reads the flag from
  the entry it lands on, so `quietCurrentEntry()` rewrites the first entry after boot, and an
  internal `<a>` carries `data-rmx-reset-scroll="false"`.

- **Late content.** A spot the scroller is too short to reach (the rows arrive after the first
  commit, or the store was shrunk while the entry was away) is kept, not forgotten: the clamp is not
  recorded over it, a ResizeObserver on the scroller and its children retries the write on each
  growth for 3 s (`R/lib/scroll-restore.ts`; the window is short because a restore that fires after
  the reader settled yanks a screen they are reading), and the reader's wheel, touch, key or pointer
  ends it. `e2e/pane-scroll-memory.spec.ts` holds both cases.

### Layout in insert callbacks

**An insert callback, a `ref` or a commit `queueTask` neither reads layout nor writes a scroll
offset unless it must.** They run inside the runtime's flush, while the new screen's DOM is fresh,
so one read of `scrollHeight`, `scrollWidth` or `getBoundingClientRect`, or one write of
`scrollTop`, forces the whole new screen's style and layout inside the tap's task. Measured at 4x
CPU: 36 ms of the 93 ms back flush was a `scrollTop = 0` on a scroller already at 0, 13 to 18 ms of
the tap was the belt's first `scrollWidth`, 10 ms and more per commit was the tail pin (research
note 05, rank 2).

- Write only when there is something to change, and track the value you wrote instead of reading
  it back (`R/lib/scroll.ts` restores only a stored spot that differs).
- Let a `ResizeObserver` take the first measurement: it fires after the browser's own layout of
  that frame, so the numbers are free (`R/routes/pane/belt.tsx` `edgeWatch`). A following tail is
  pinned by the scroller's `ResizeObserver` on any size change, the first frame included; a commit
  pins only for an anchor, a spot to restore or an explicit "go to the tail"
  (`R/routes/pane/terminal.tsx`, `R/routes/pane/chat.tsx`). Without an observer, one
  `requestAnimationFrame` after insert.
- Inside one measurement, all reads first, then one write, skipped when the value did not move.
- A one-off read after insert goes through `afterLayout(node, read, write, signal)` (`R/lib/after-layout.ts`):
  one shared `ResizeObserver` delivers it after the frame's layout, and every read due in that frame
  runs before any write. The strips' active-pill reveal (`R/routes/pane/strips.tsx`) and the gestures'
  `touch-action` check (`R/lib/gestures.ts`) use it; before, they cost 37 and 18 ms of the tap at 4x.
- `getAnimations()` flushes style for the whole document. Collect animation handles once, after
  the first paint, and refresh them on `animationstart` or `animationcancel`
  (`R/shell/collie-mark.tsx`).

### Reloads

Never call `location.reload()`. The runtime intercepts it into a router re-run in the same document,
which keeps the old entry chunk. Use `reloadDocument()` from `R/update/pwa.ts`, which passes the
runtime's own marker (`info: "remix-document-reload"`).

### API URLs

The bridge's route map is `shared/routes.ts` (repo root), one file for the bridge router and this
shell. This shell imports it as `@shared/routes`, and only `R/lib/urls.ts` turns it into URLs.
Never write `"/api/..."` in a component, loader or store; add a builder to `urls.ts` and a case
to `urls.test.ts`. A builder returns the same bytes `encodeURIComponent` gave (a dot stays bare),
and the mount is added later by `mounted()`. Keep `shared/routes.ts` browser-safe: only
`remix/routes` may come in, never a `bridge/` module. Calls that go through `@web/lib/api` are not
covered, because web/ spells its own paths.

## Server document

Since S1 (`experiments/remix-v3/ACTION-PLAN.md` B) the bridge renders `/` and `/pane/:paneId` on Bun
from the request's snapshot (`R/ssr/render.tsx`, wired in `bridge/http/controllers/document.ts`), and
`R/main.tsx` hydrates it in place. Every component on those two routes, and the Shell around them,
now runs on Bun as well as in the browser. The rules:

- **Module scope touches no browser API.** The bridge imports the shell to render, so a module that
  reads `document`, `window`, `localStorage`, `navigator`, `matchMedia` or `crypto.randomUUID` when
  it evaluates breaks the bridge, not a page. Wrap such code in `if ("document" in globalThis)` (or
  `"window"`), as `R/routes/settings/install.tsx` and `typeface.tsx` do. `globalThis.x?.()` is fine.
- **Setup registers nothing past the request on the server.** On Bun `handle.signal` never aborts
  and `queueTask` is dropped, so a listener, a poll source or a timer added in setup lives for the
  life of the bridge and holds the request's data. Check `onServer()` (`R/lib/server-render.ts`)
  before `want()`, `subscribe…()`, `window.addEventListener` or `setInterval` in setup. `want()`
  checks it itself. `useStore` and `useStoreSelect` are safe: they subscribe in `queueTask`, which
  the server drops.
- **Render reads stores, never the request.** A render primes the module stores for its request
  and resets them all before the call returns (`resetStores`). This is only safe because the whole
  tree builds inside one synchronous call. Do not `await` in setup or render on the server path,
  and do not read a store in a callback that runs later. `R/ssr/render.test.tsx` renders two
  snapshots back to back and interleaved and asserts neither output holds the other's panes.
- **The first render must match on both sides.** Hydration patches a mismatch, it does not throw,
  so a mismatch is a silent text or attribute swap after load. Anything that depends on the device
  and not on the snapshot or the prefs cookie (pointer type, viewport, reduced motion, the clock
  past the snapshot) must not change the markup of the first render. Pick by CSS instead
  (`pointer-fine:hidden`, as the pin hint does), or change it after mount.
- **Links carry the mount through `href()` and `mounted()`.** On Bun there is no
  `<meta name="collie-base">`; `W/lib/base-path.ts` asks `R/lib/server-render.ts` for the render's
  mount instead. Never write a root-absolute path by hand.
- **Prefs come from the cookie.** `R/lib/prefs.ts` writes the device's prefs to the `collie-prefs`
  cookie (under 3,000 bytes, else none) on boot and on every change, and the bridge primes the prefs
  stores from it. A pref that is not in the cookie renders its default on the server.
- **One island.** The document holds `AppRoot` (`R/app-root.tsx`, id `collie:app#AppRoot`), and its
  props are the snapshot, the config and the path. A new route the bridge should render goes into
  `matchAppRoute` and `appRouteNode`, and the router's action must draw the same node
  (`homeNode()`, `paneNode()`), so the first routed tap replaces the body with the same tree.
- **Anything the server paints that only JavaScript clears has a CSS-only exit.** The static shell's
  splash (`index.html`) and the pane's `screen-skeleton` (`src/app.css`) hide themselves after 8 s
  with `animation: ... var(--failsafe-delay, 8s) forwards`, so a bundle that never arrives leaves a
  quiet page, not a placeholder that says "loading" forever. `--failsafe-delay` is test-only
  (`e2e/ssr-boot.spec.ts` (i) sets it to 0.6 s with JavaScript off). A new server-painted placeholder
  needs the same rule (research note 09, D2.4).
- **The static shell stays the fallback.** Offline, the service worker's cache, a refused gate and
  every other route boot from `index.html` with its splash. Keep both boots working: e2e
  `ssr-boot.spec.ts` covers the server document, the rest of the suite the static shell.

## Frames

Since S2 (`experiments/remix-v3/ACTION-PLAN.md` B) the pane's rows can be drawn on the bridge too, as
two named frames on the pane's own URL (`R/routes/pane/frames.ts` names them and lays out the answer):

- **Off by default.** S2 had two bounds: no more renderer CPU while a pane streams than before, and
  no more than 1.5x the bytes of the JSON read. The CPU bound held (Terminal, 1x: 3.4 % of one core
  against 3.7 % with frames off, same build, same hour). The bytes bound did not: one poll answer is
  the read's JSON plus the rows' HTML, 1.6x the JSON read after gzip (2.4 against 1.5 KiB on a
  working pane), and 432 against 262 KiB over a 30 s Terminal stream. So `PANE_FRAMES_DEFAULT` is
  `false` (`R/lib/prefs.ts`), and a device turns frames on with `?frames=1` (stored; `?frames=0`
  turns them off again). Numbers: `experiments/remix-v3/COMPARE.md`, round 8. Everything below is
  what happens with frames on; with them off the pane reads `/api/pane/:id` as JSON and the browser
  draws every row, as before S2.

- **What streams.** `pane-screen` is the Terminal's rows (`ScreenRows`), `pane-status` the agent's
  statusline rows (`StatusRows`). Only the rows: the `<pre>` and the strip around them (font, wrap,
  theme, `data-rows`) stay the browser's, so a pref never changes a fragment. Chat stays the browser's
  (its window has its own after-cursor protocol, `fetchChat`), and so do the header, the strips, the
  card, the composer, the belt and the sheets. The find bar takes the rows back while it is open:
  its marks are the browser's.
- **One request per beat.** The beat (`R/lib/polling.ts`, unchanged) calls `pollPaneFrames`
  (`R/routes/pane/pane-frames.ts`): one GET with `X-Remix-Frame`, `X-Remix-Target` and
  `X-Collie-Poll: <frames>`, answered with the read's JSON and every asked frame in one body. The read
  still goes into the pane's store and web's pane cache (`notePaneRead`), because the card, the
  composer and the dialog guard read the text.
- **304 never reaches the runtime.** The runtime treats a 304 as a failure and an empty body as "clear
  the frame", and `reload()` takes no options. So the poll asks first, with the read's ETag as
  `If-None-Match`; on 304 nothing happens at all (no `reloadStart`, no diff, no store write); on 200
  the rows are held by src and each mounted frame whose rows moved is told `reload()`, which the
  runtime resolves from the held HTML (`resolvePaneFrame`) with no second request.
- **Keyed rows.** Every row carries `data-rmx-key`. The JSX `key` is not emitted, and an attribute
  without the `data-` prefix (`rmx-key`, `rmx-target`) type-checks and is ignored. The runtime's HTML
  diff (`diff-dom.ts`) places rows from the end and removes stale ones only after, so a row replaced
  in the middle moves every row above it. Hence two kinds of key (`R/ssr/frames.tsx`, THE TAIL):
  content keys for the rows above, so a scroll is one row in and one row out, and place keys
  (`tail-0` is the last row) for the bottom 8, where a working agent changes its screen, so those
  diff in place. A row that changes above the tail still moves the rows above it: that is the
  runtime's diff, measured in COMPARE.md round 8.
- **Vary and storage.** `/pane/:paneId` answers a document or a fragment by request header, so every
  answer on it says `Vary: X-Remix-Frame, X-Remix-Target, X-Collie-Poll`, the fragments
  `Cache-Control: private, no-store`, the document `no-store`. A frame request never falls through to
  the document or the static shell.
- **Mount rule.** The frames' src is mounted with `href()` on BOTH sides. The server never fetches a
  frame: the document reads the pane through the pane route's own body and draws both frames inline
  through `renderToStream`'s `resolveFrame` (`R/ssr/render.tsx`), so the server-side mount trap of
  research note 08 §3.6 never arises, and the hydrated frame's src equals the one the browser draws.
  The bridge's frame route gets the routed URL, mount already off. Everything that changes a row's
  markup is in the src (`lines`, `agent`), so a change of it is a new URL and never meets a stale ETag.
- **Same mode on both sides.** The switch is the `collie:pane-frames:v1` pref (in the prefs cookie)
  and `?frames=0|1`. The document says which mode it drew (`pane.frames` in the island's props), and
  the browser hydrates in that mode for the page (`paneFrames.prime`). A server-drawn frame is
  adopted as it is: no reload, no entrance motion (e2e `pane-frames.spec.ts` (f)).
- **Not ours, offline.** Every frame answer carries `X-Collie-Frame`. An answer without it (a proxy's
  page, a service worker shell, an older bridge, a static server) latches the JSON read for the
  page's life. A failed request leaves the rows and the store's last body in place and sets the
  store's error, as the JSON read did, so the pane says "can't reach" over the last rows (M46 keeps
  what it kept). A refused read keeps its status, so the pane shows the same notice.
- **Frozen.** While the reader is scrolled up, the screen frame is not reloaded (rule 8). The held
  rows keep moving and land at once on the jump back, with no request.
- **The glide** binds the `pane-screen` frame (`bindGlideScreenFrame`) and waits for a reload in
  flight to complete before it takes its snapshot. A frame's first content in the browser is not a
  reload: the runtime dispatches nothing for it.

## Motion

### CSS first

- Static visual states and transitions are CSS (`G/07-animation.md`, "CSS-first visual states").
- Our static styling is Tailwind classes, with the tokens and keyframes of `W/index.css`. Changing
  values go in `style` (`C/docs/styling.md`, "CSS Mixin vs Style Prop").
- Use `css()` only for what a class cannot say, and never with a value that changes per render: each
  new value mints a rule. `css()` rules sit in `@layer rmx`; do not set one property from both.
- Hover, focus and pressed states are CSS selectors, not JS.

### `Collapse`

D §11 rule 1: `grid-template-rows: 0fr ↔ 1fr` plus opacity over 240 ms, ease-out, holding the last
child through the exit. Port `W/components/ui/collapse.tsx` to `R/ui/collapse.tsx` first; nothing
that needs it may land before it.

```tsx
export function Collapse(handle: Handle<{ open: boolean; children?: RemixNode }>) {
  let held: RemixNode = null; let shown = false; let timer = 0;
  handle.signal.addEventListener("abort", () => clearTimeout(timer));
  return () => {
    if (handle.props.open && handle.props.children) held = handle.props.children; // last non-empty
    // opening: render 0fr, flip `shown` in a queueTask + rAF (two-frame start)
    // closing: keep `held`, render 0fr, drop `held` after COLLAPSE_MS via `timer`
    const rows = shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0";
    return <div class={cn("grid transition-[grid-template-rows,opacity] duration-[240ms] ease-out", rows)}>
      <div class="min-h-0 min-w-0 overflow-hidden">{held}</div></div>;
  };
}
```

- The inner wrapper needs `min-h-0` and `min-w-0`, for the reasons in the `W/` file header.
- `CollapseSwap` (two surfaces in one band, one height motion) ports beside it.
- Reduced motion: the CSS drops the transition; the timer still removes the held child.

### Hold

The long-press mixin sets `data-holding` and the inline duration. `W/index.css` does the rest: 97%
scale and a 12% tint of the element's own ink, tint alone under reduced motion (D §2).

### The glide

A row IS the next screen's header (D §12, ADR 0069). Forward is the tap on that row. Reverse is the
in-app back arrow only, never the edge swipe. 250 ms ease-out, parts dot, tile and name, prefetch on
`pointerdown`, wait at most 120 ms for the parts, else a plain slide (`W/lib/glide.ts`). The pane
prefetch asks for the screen's own `?lines=600` read and seeds the pane store on the tap, so one tap
costs one read (`R/routes/home/open-pane.ts`).

- Port the rules of `W/lib/glide.ts` to `R/lib/glide.ts`. The move runs inside
  `document.startViewTransition`'s update callback, and each part gets its `view-transition-name`
  for one transition only.
- No Remix package has view transitions (research note 01, section 4).
- The 240 ms screen slide (`W/components/screen-transition.tsx`) runs only dashboard to pane and
  back, not on a POP, and stands down while a glide runs.
- Use the gated seam (P5 Q4): add the `reloadComplete` listener first, then `startViewTransition`,
  then navigate; a first router middleware awaits "old snapshot taken" before the route renders. The
  naive seam (the callback waits for `reloadComplete`) captures the new page on an instant route and
  freezes Chromium's frames for 4 s. The gated seam works for links, `navigate()` and back in
  Chromium; WebKit's old snapshot is right, its morph is unconfirmed by eye. `R/lib/glide.ts` and
  the first middleware in `R/router.tsx` implement it. Name only the parts that morph: named rows
  escape their scroller's clip.

#### One transition at a time

`startViewTransition` never runs while the previous transition's update callback is pending
(Chrome throws `InvalidStateError`; research note 07, c.3). `R/lib/glide-queue.ts` keeps ONE pending
slot: a glide asked for in that window waits for `updateCallbackDone` and starts then, latest wins.
A move that loses the slot or meets an instant path (reduced motion, a glide in flight, no API) still
happens, instantly and in arrival order; only its transition is cancelled, because the move is the
operator's tap and its history entry counts (ADR 0067). A queued move the location outran is dropped.
A superseded transition's callback stops waiting for its landing at once, `ready`/`finished`
rejections are swallowed, and a `startViewTransition` that throws moves instantly. `R/lib/glide.test.ts`
holds the scheduler, in the shape of kody's.

#### Frames during a view transition

Chromium runs no animation frames while a view transition's update callback is pending. Every
store and model update waits for one (`scheduleUpdate`), so before this rule the arriving pane
header never drew inside the callback: the screen froze for 433 to 450 ms, then crossfaded instead
of the morph (React: 66 to 95 ms). So the glide holds frames from `startViewTransition` until the
callback settles (`holdFrames()` in `R/lib/store.ts`, released in `R/lib/glide.ts`). While held,
`scheduleUpdate` runs on `setTimeout(0)`, and the updates already waiting for a frame move to a
timer. A timer ends the turn, so the 50-update guard stays safe; never use a microtask here.
Measured 2026-10-06, Chromium, loopback: longest frame gap after a row tap 33 to 67 ms, the parts
morph, `html.glide` gone at 400 to 470 ms, the 40 ms busy-bar flash is gone. Anything else that
waits on rAF (the Collapse two-frame start) still waits for the callback to end; keep it out of
what a glide's callback needs to see.

### Sheets

- Open: backdrop fade 200 ms, panel slide from the bottom 200 ms (`W/components/ui/sheet.tsx`).
  `R/ui/sheet.tsx` does this with CSS classes today. Keep it.
- Drag-dismiss: the panel follows the finger by `style.transform`; past 90 px it closes; short of
  it, it snaps back.
- The snap-back is a CSS transition, `transform 200ms ease-out`, as `W/components/ui/sheet.tsx`
  has it (`snapBackTransition()` in `R/lib/motion.ts`). It is not a spring: `spring("snappy")`
  settles in 350 ms, 150 ms longer than web (commit aca27316).
- Peek-to-open continues the finger's motion over 180 ms (`SheetPeek`, `R/ui/sheet.tsx`).
- Measured (P5 Q6, so the snap-back above is not a spring): a preset's name is not its length. `spring(p).duration` is the settle time and
  the exit holds the node that long: snappy 350 ms, bouncy 550 ms, smooth 1050 ms. Plan with
  `spring(p).duration`. An exit uses the config of the last render that showed the node, so render
  the exit settings before the node goes.

### Toasts

Fade in over 200 ms, no exit animation, 2.5 s TTL, errors persist (`W/components/status-area.tsx`).
A toast floats in the overlay layer and holds no space (D §2). Use the CSS `animate-in fade-in`
classes or `animateEntrance(toastEntrance())` (200 ms, easing `ease`, from `R/lib/motion.ts`). Every publish also spins the mark one
orbit.

### `animateLayout` and keyed motion

- `animateLayout` (FLIP) is the tool for movement the operator caused (`U/`, "Layout Animation").
- Rows never move on a poll (D §2, ADR 0071). No list in this app animates a reorder today, so any
  use of `animateLayout` needs a line in D first.
- `animateExit` needs a keyed node, and a keyed node that returns during the exit is reclaimed
  (`C/docs/mixins.md`, `persistNode`).
- A keyed move uses `insertBefore`, which cancels a running CSS transition on the moved node: it
  snaps to its end value (P5 Q5, 21 of 21 moved rows). No CSS transitions on reorderable rows.
  `animateLayout` is smooth and survives interruption but costs about 0.12 ms per row per reorder
  (24 ms at 200 rows in Chromium, 32 ms in WebKit), so use it only up to about 50 rows (P5 Q5).

### Reduced motion

- Treat it as its own behaviour path (`remix-website: AGENTS.md`). The helpers do not check it
  (research note 01, section 4).
- CSS first: `@media (prefers-reduced-motion: reduce)` drops transitions (`G/07-animation.md`,
  "Reduced-motion behavior").
- JS: check `matchMedia("(prefers-reduced-motion: reduce)")` before a view transition, a spring, a
  WAAPI call or the orbit. Under it: no glide, no slide, hold shows tint only.

### The mark orbit

- The orbit is a rAF loop outside render. It runs 1800 ms per round and adjusts the mark's CSS
  animations with `updatePlaybackRate` (`W/components/collie-home.tsx`).
- Start it in `ref((node, signal) => ...)`. Stop it on that signal. It never calls `update()`.
- `components/collie-mark.tsx` is generated from the brand repo (D §8). Do not hand-port it; the
  generator must emit the Remix variant.

## High-frequency views

### Terminal screen and chat stream

- The mirror is keyed rows (`R/screen/rows.ts`, `toRows(lines, prev)` reuses unchanged rows by key).
  Keyed and unkeyed cost the same on a full replace (SPIKE, probe 3).
- Measured in Chromium at 4x CPU throttle: keyed cell update p95 3.6 ms, full replace p50 13.9 ms, no frame over
  50 ms (SPIKE, probe 3 table). Stay in the vdom for the mirror.
- Chat blocks are keyed by block id (`R/routes/pane/chat.tsx`). Keep it.
- "Load older" holds the reader's place by the FIRST VISIBLE BLOCK, not the distance from the bottom
  (`R/chat/anchor.ts`): each block carries `data-key` (its first item id); the tap measures the first
  block still in view, and after the page's layout `afterLayout` moves `scrollTop` by that block's
  drift. The merge itself is web's `mergeChat` (by uuid, ordered by seq, a repeated turn written over).
- While the reader is scrolled up, the rows under their eye are frozen (`R/routes/pane/terminal.tsx`).
  The mirror is the one surface allowed to move by itself, and only at the tail (D §2).

### The two-step pane mount

The runtime commits a route render in one task with no yield, so the pane used to mount header,
screen, composer, belt and four sheets in one 135 to 182 ms task at 4x CPU. `R/routes/pane/pane.tsx`
now mounts in two steps. Step one: the header claim, strips, notice, screen, dialog card, the two
bands, and `ComposerStandIn` (`R/routes/pane/composer.tsx`), a box of the composer's exact height
built from the same class constants. Step two, after the first paint (the commit task asks for one
rAF, the rAF for a `setTimeout`, the timer calls `scheduleUpdate`): the composer and the sheets. While
a glide holds frames, step two waits for the update callback, like every rAF. In-flow parts whose
height cannot be reserved without drawing them stay in step one. `e2e/pane-two-step.spec.ts` holds
the chrome block's top and height, and the screen's tail, still across the swap. `e2e/pane-mutation-log.spec.ts` logs what the DOM did per phase from the tap (glide on, step one's batch, the header claim, step two a later frame, glide off) and asserts that order, so a change that lumps the mount into one task fails it (checked by forcing `full = true`). Measured 2026-10-07,
4x CPU, median of 5: longest tap task 103 to 67 ms, tap blocking 77 to 20 ms.

Chat blocks carry web's `STREAM_BLOCK` verbatim (`content-visibility: auto`,
`contain-intrinsic-size: auto 64px`), so the first layout skips the blocks off screen. Measured on top
of the two-step mount: layout until the text paints 36 to 33 ms, style 77 to 68 ms, tap-to-text 304
to 276 ms, and no frame where the tail moved.

### When to bypass render

- Bypass only for a surface that changes faster than polls: a canvas, a sparkline, a clock text.
- Render an element with no vdom children and paint it through a ref. It keeps its painted children
  through parent re-renders, with or without `data-rmx-preserve-dom` (SPIKE, probe 3).
- Copy props into setup variables in render and start the painter once, idempotently, from a
  `queueTask`. Dispose on `handle.signal` (`remix-particle-visualizer`).
- Use a frame governor: 60 fps while active, 30 fps after 5 s idle (`remix-particle-visualizer`).
- Write `textContent` for a ticking label, as the remix website does every 500 ms.
- Never measure or write the DOM in render.
- Measured (P5 Q7): a host with no vdom children keeps 100 imperative rows, the same nodes, across
  60 parent renders, and its attributes still patch. Imperative siblings beside vdom children also
  survive. `data-rmx-preserve-dom` changes nothing on client renders.

### The burst rule

A poll, a socket message or a stream chunk writes a store. The store wakes `scheduleUpdate`. Nothing
on this path calls `update()`. A stream reader that drains buffered chunks in one turn is a burst.
So is a `MessageChannel` queue. So is a WebSocket.

## Forms, inputs and the composer

- Uncontrolled by default. Read `event.currentTarget.value` in the handler (`C/docs/patterns.md`,
  "Controlled vs Uncontrolled Inputs").
- Control a value only when something besides the user's typing also sets it.
- The composer textarea stays uncontrolled even so, because a poll re-renders it many times a
  second. Restoring a draft, inserting `[Image #N]` or clearing on send writes `node.value` through
  the ref, then dispatches `input`. Never pass `value=` to the composer.
- Sizing: `field-sizing-content`, max `min(10rem, 30dvh)`, `text-base` (16 px stops iOS zoom)
  (research note 03, section 6).
- Keyboard: the viewport meta carries `interactive-widget=resizes-content`, height is `--app-h`
  (100dvh). The keyboard counts as open at a 150 px drop and closed under 100 px. While composing,
  strips, status line and footers leave through `Collapse`.
- Drafts: one per pane, saved on input, restored on mount. A pending app-update reload waits for it
  (`R/update/reload-hold.ts`). Direct typing is never persisted.
- "Sent": the check on the button for 1.5 s, the "Sent" preview in a `Collapse` up to 6 s. Never an
  in-flow row that moves the mirror (D §2, the 30 px shift).
- Forms that submit to the bridge use `fetch` with the handler's signal. There are no Remix actions
  on the server side of this app.

## Lists and keys

- Key every list by a stable id: `paneRowKey(a)`, a group's `g.key`, a row's `row.key`, a block's
  `id`. An index key is allowed only for a static list that never reorders.
- Remix does not need keys for positional diffing, but we key anyway. Keys keep identity, focus and
  exit motion right (`C/docs/composition.md`, "Key Prop").
- Frozen ranks: the order is read once on open or on the operator's tap, then held. Port
  `W/hooks/use-frozen-ranks.ts` as a plain module plus a setup variable (ADR 0071).
- Reserved slots: a mark that may appear keeps its slot invisible (`R/ui/unseen-mark.tsx`). A word
  that changes uses `one-of`, sized by the widest word in the locale (port `W/components/ui/one-of.tsx`).
  Borders are reserved transparent in the base class (D §2).
- `data-rmx-preserve-dom` acts only on frame reloads from server HTML. In this SPA it does nothing
  (`C/src/runtime/diff-dom.ts`; SPIKE, probe 3).
- The `jsx-key` lint rule from React does not apply. Keep keys by choice, not by lint.
- **`rmx-*` attributes need the `data-` prefix.** `rmx-key`, `rmx-target` and the rest type-check,
  because JSX accepts any hyphenated attribute, and the runtime ignores them; only `data-rmx-key`,
  `data-rmx-target`, `data-rmx-src` and the other `data-rmx-*` names are read (`C/src/runtime/`).
  The row looks keyed and is not. `R/lib/rmx-attributes.test.ts` fails on any JSX attribute under
  `src/` that starts `rmx-` (research note 09, D2.5).

## Testing

### Three layers

1. **`bun test` for pure modules.** Cadence, rows, keys, nav, pairing: `R/lib/*.test.ts`,
   `R/screen/rows.test.ts`, `R/composer/keys.test.ts`. Move logic out of components so it lands here.
2. **Playwright against the stub API.** `web-remix/e2e/serve.ts` serves the build and stubs the bridge
   (`e2e/pane-api.ts`, `e2e/settings-api.ts`). Specs: `e2e/smoke.spec.ts`, `e2e/pane.spec.ts`. Run
   Chromium, and WebKit from the `wk` distrobox (SPIKE, "Run it").
3. **Live, read-only.** `e2e/settings-live.ts` against a running instance. Only reads. Never a verb
   that restarts a unit.

### Techniques

- Hold a navigation open to assert pending UI: listen to `navigation`'s `navigate` event and call
  `event.intercept({ handler: () => gate })`, then resolve `gate` (`remix-jam-2026-demos:
  install.test.browser.tsx:39`).
- Finish animations before you measure: `document.getAnimations().forEach((a) => a.finish())`.
- Catch a layout shift with a rAF sampler of a neighbour's `getBoundingClientRect()`. A glide is a
  run of eased values; a jump is two values one frame apart (D §2).
- Query by role, `data-testid` or `data-slot`. Never assert literal copy alone; copy is translated
  (`remix-website: AGENTS.md`).
- Burst tests send 60 updates in one task and assert DOM equals model 50 ms later (SPIKE, probe 3).
- Component tests in the browser use `render` and `act` from `remix/component/test`
  (`I/` → `src/component/test/README.md`).

## Anti-patterns

The Remix authors, quoted. One line each.

- "Don't create states as values to 'react to' on the next render with `queueTask`" (`C/docs/handle.md`).
- "Setting context values does not automatically trigger updates… calling update() can cause expensive updates of the entire subtree" (`C/docs/component.md:635`).
- "Avoid: Using css(...) for dynamic styles" (`C/docs/styling.md:33`).
- "Only control an input's value when something besides the user's interaction with that input can also control its state" (`C/docs/patterns.md`).
- "Read changing props from handle.props during render… Do not apply React hooks or lifecycle assumptions" (Remix `SKILL.md`).
- "Doing DOM measurement or mutation during render" (visualizer skill).
- "Letting animation loops continue after a component is removed" (visualizer skill).
- "Do not call handle.update() before async work in a task" (epic-scheduler docs).
- "Keep setup functions at module scope and keep mixin ordering stable" (`C/docs/mixins.md`).
- "Most app code should stick with on('click', ...) and other native events" (`C/docs/interactions.md`).
- "Prefer CSS for visual states and animations… keep JavaScript for state/timing rather than frame-by-frame styling" (`remix-website: AGENTS.md`).
- "Treat prefers-reduced-motion as its own behavior path" (`remix-website: AGENTS.md`).
- "MUST build dialogs, popovers, menus, tooltips, and disclosure UI with native HTML platform features" (`sergiodxa/monorepo: AGENTS.md`).
- "The island's own signal, not the render-scoped one: handle.update() below aborts the latter" (`sergiodxa/monorepo: run-monitor-button.tsx:165`).

## Known rough edges

- **Reload interception.** The runtime intercepts reloads and same-document hash navigations ("HACK"
  in `docs/guides entry.ts:74`). Its marker is not exported, so `R/update/pwa.ts` copies the literal
  `remix-document-reload`. Re-check it on every Remix upgrade.
- **No 405.** A GET to a POST-only path falls through to a less specific route (SPIKE, probe 1). The
  bridge stays the server; if a Remix router ever serves `/api`, it needs its own guard.
- **Raw path.** Route patterns match the raw pathname. The ADR 0052 mount must come off before
  matching (`mountedRouter` in `R/router.tsx`) and go back on every link (`href()` in `R/routes.ts`).
- **Weak ETag.** `IfNoneMatch.matches()` is exact-match only, so `W/"tag"` misses (SPIKE, probe 1).
- **`@remix-run/ui` 0.12 is unstable.** Many BREAKING entries. Use only `animation`, pin the exact
  version, and wrap it in one `R/lib/motion.ts` so an upgrade touches one file.
- **Age gate.** `remix@3.0.0` and its 48 packages were published 2026-10-01. The 7-day
  `minimumReleaseAge` gate in `bunfig.toml` blocks them until 2026-10-08. Do not widen the exclude
  list beyond those names.
- **Remix's own `<Frame>` needs `crypto.randomUUID`.** The runtime calls it (`randomFrameId`) for
  every nested `<Frame>` the browser renders itself, and `randomUUID` exists only in a secure
  context. The dev and remix lanes are plain `http://bluefin:<port>`, where it is `undefined`, so a
  frame there throws on mount and the page stays blank. Since S1/S2 the pane draws two named frames,
  so `R/lib/polyfills.ts` fills `crypto.randomUUID` from `crypto.getRandomValues` before `run()`
  (`installPolyfills()` in `R/main.tsx`), and `Promise.withResolvers` and `Object.hasOwn` with it.
  Keep that call first in `main.tsx`; a new entry point (a worker, a test page) that renders a frame
  needs it too. The top frame does not use it (`run.ts`), which is why the shell ran for months without
  the polyfill. Collie's own `Frame` in `R/routes/frame/frame.tsx` is a page layout and unrelated.
- **Navigation API.** Without `window.navigation` and `NavigateEvent.sourceElement`, every link is a
  full document load (SPIKE, probe 4). Check the oldest supported iOS on a real phone.
- **Handler rejections.** A rejected promise from an `on()` handler is swallowed (research note 01,
  section 2). Catch inside.

## Collie-specific mapping

The top 15 visible differences from research note 03, section 7. "Owner" is the file that will own
the work; a file marked *new* does not exist yet.

| # | Difference | Remix pattern | Owner |
| --- | --- | --- | --- |
| 1 | Shared header host: mark, "Collie on mux", 60 px floor, notch, rule | `HeaderModel` in context from the Shell; host mounted once; routes claim | `R/shell/header.tsx`, `R/shell/header-model.ts` (*new*) |
| 2 | Pane header identity: tile and dot, name, workspace + host + cache, ⋮ | claim `{ center, right, width: "wide" }` with setup callbacks | `R/routes/pane/header.tsx` (becomes a claim) |
| 3 | Row-to-header glide and the 240 ms slide | view-transition seam around `navigate`; CSS slide | `R/lib/glide.ts`, `R/shell/screen-transition.tsx` (*new*) |
| 4 | Actions belt: 37 px pills, 64 px fade, pinned Switch, harness bar | keyed pills; `pan-x` scroller; vertical `pull` mixin dispatching `app:pull` | `R/routes/pane/belt.tsx` (*new*), `R/lib/gestures.ts` (*new*) |
| 5 | Composer: attach, mic, direct typing, send check, sent and draft previews | uncontrolled textarea, ref writes, `Collapse` for previews, draft store | `R/routes/pane/composer.tsx`, `R/lib/drafts.ts` (*new*) |
| 6 | Collie mark orbit and bloom on every route | generated mark in the header host; rAF orbit in `ref`, ends on signal | `R/shell/collie-mark.tsx` (*new*, generated) |
| 7 | Row details: cache chip, hold-fill, host chip, unseen square, alarm edge | `longPress` mixin; reserved slots; one shared 1 s clock store | `R/routes/home/agent-row.tsx`, `R/lib/clock.ts` (*new*) |
| 8 | Summary line, needs-you switch, order toggle, Pinned group | persisted module stores (same `localStorage` keys); frozen ranks | `R/routes/home/prefs.ts`, `R/lib/frozen-ranks.ts`, `R/lib/pins.ts` (*new*) |
| 9 | `Collapse` and the no-shift rule | `Collapse`, `CollapseSwap`, `OneOf`; pane status moves to the header | `R/ui/collapse.tsx`, `R/ui/one-of.tsx` (*new*) |
| 10 | Sheets: peek-pull, drag-dismiss, action sheets | native-listener drag in `ref`; CSS 200 ms ease-out snap-back; no history entry | `R/ui/sheet.tsx`, `R/routes/home/pane-actions-sheet.tsx` (*new*) |
| 11 | Strip band: connection, update, read-only, notch rule | `StripModel` in context, priority table, one live region pair kept mounted | `R/shell/strip-host.tsx` (*new*) |
| 12 | Pane tab and pane strips with the fold bar | `CollapseSwap`; pref `collie:strips-collapsed:v1`; stand down while composing | `R/routes/pane/strips.tsx` (*new*) |
| 13 | Chat polish: start state and gate, tool folding, question notes, font, Load older | keyed blocks; gate reused read-only from `W/lib/chat-gate.ts`; anchor on Load older | `R/routes/pane/chat.tsx`, `R/chat/*` |
| 14 | Native wizard, multi-select, preview cards | grammars reused read-only from `W/lib/harness/claude/*`; one verified keystroke per tap | `R/routes/pane/cards/*.tsx` (*new*) |
| 15 | Persisted prefs, Crew and Files tabs, Spaces and Launch | module stores over the `W/` keys; new routes in `R/routes.ts` plus `W/lib/nav.ts` levels | `R/lib/prefs.ts` (*new*), `R/routes/crew/`, `R/routes/files/` (*new*) |

Cold open must look the same as `W/`. That means prefs load before the first render, from
`localStorage`, synchronously.

## Where the current shell stands

### Already follows the rules

- One coalescer for every store wake, subscription after first commit, end on signal (`R/lib/store.ts`).
- Polling reads bound to the component's life with `want(source, handle.signal)` (`R/lib/polling.ts`).
- Router and Shell at module scope; `render()` wraps every route; remount keeps the router
  (`R/router.tsx`, `R/main.tsx`).
- Actions do no fetching; screens paint from stores at once (`R/router.tsx`).
- The ADR 0052 mount comes off before matching and goes back on in `href()` (`R/router.tsx`, `R/routes.ts`).
- `reloadDocument()` instead of `location.reload()` (`R/update/pwa.ts`).
- Up from the pane follows ADR 0067 (`R/routes/pane/back.ts`).
- Keyed mirror rows reused by key, derived data cached by input identity, spot memory, pin in a
  `queueTask` (`R/screen/rows.ts`, `R/routes/pane/pane.tsx`, `R/routes/pane/terminal.tsx`).
- Hold handlers built once in setup, reading current props at fire time (`R/ui/chip.tsx`,
  `R/routes/home/agent-row.tsx`).
- The sheet's pull-down uses native listeners in a ref with `passive: false` (`R/ui/sheet.tsx`).
- The idle cover sits over a mounted, `inert` tree (ADR 0007, `R/shell.tsx`).

### Must change

1. `R/shell.tsx` subscribes to `snapshot` and `config` only to re-render. That re-renders every route
   on every poll. Remove both `useStore` calls (rule 4).
2. `R/routes/pane/action.tsx` and `R/routes/space/action.tsx` render without a `key`. A sideways move
   from one pane to another reuses the instance with the old `paneId` and scope. Key by
   `paneScopeKey(scope, paneId)` (rule 3).
3. `R/routes/pane/pane.tsx` draws an in-flow status `<p>` whose padding changes with the status, and
   mounts the notice and `CardDock` bare. Move status to the header slot; wrap the rest in
   `Collapse` (rule 7).
4. `R/routes/pane/header.tsx` draws a header inside the route, and home has none. Build the header
   host and make routes claim it (rule 6).
5. `R/lib/long-press.ts` has no `data-holding`, no haptic and is not a mixin. Port to `createMixin`.
6. `R/routes/settings/page.tsx:38` and `R/routes/settings/settings.tsx:67` push a parent with a bare
   `navigate`. Route them through one `R/lib/nav.ts` (rule 9).
7. The pane's bottom Chat/Terminal `TabBar` does not exist in `W/`. The view is a device pref, switched
   in the ⋮ sheet, chosen by the chat gate (ADR 0082).
8. `R/ui/` lacks `Collapse`, `CollapseSwap` and `OneOf`. Port them before any feature that needs them (D §1).
9. Dashboard and Settings scrollers have no spot memory.
10. `R/lib/store.ts` `subscribe` takes no signal. Add one.

## Probe 5 status

Landed 2026-10-06 (commit 0aa41190). Each former `TODO(probe5)` marker above now states the
measured answer and cites its section as `P5 Qn`.
