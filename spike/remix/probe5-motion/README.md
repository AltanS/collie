# Probe 5: motion, lifecycle and navigation in `remix/spa`

A second spike for the Remix 3 rewrite. One small client-only app answers ten open questions with
Playwright measurements. Throwaway code. Nothing under `web/`, `web-remix/`, `bridge/` or `cli/`
changed.

Measured 2026-10-06 on bluefin: `remix@3.0.0` (`@remix-run/component` 1.0.0), `@remix-run/ui` 0.12.1,
Vite 8, Playwright 1.62.1, Chromium 151 (headless shell) and WebKit 26.5 (WPE, run in the Ubuntu
distrobox `wk`). Viewport 390x844 at DPR 2. WebKit timers have 1 ms resolution.

Every answer is labelled **measured** (a number or a DOM fact from the run) or **inferred** (read
from the source or reasoned from a measurement).

## The app

- `app/main.tsx`: the router. The shell is installed once at module scope with
  `render((content, { url }) => <Shell url={url}>{content}</Shell>)`. Routes: `/`, `/list` (resolves
  after 300 ms), `/pane/:id`, and `/lab/:name` for the labs. A first middleware is the view-transition
  gate (Q4).
- `app/shell.tsx`: the shell (header, clock, 2 px pending bar, view-transition seam).
- `app/pages.tsx`: home, the list with an inner scroller (Q8), the pane view (Q2).
- `app/labs/*.tsx`: one lab per question. Each exports a component and a small driver object.
- `run.ts`: the Playwright driver. `results/chromium.json` and `results/webkit.json` are the raw output.
  `results/q4-*.jpg` are paused view-transition frames.

## Run it

```sh
cd spike/remix
bun install
bun run build:motion
bun run preview:motion &          # 127.0.0.1:5190 only
bun probe5-motion/run.ts http://127.0.0.1:5190 chromium > probe5-motion/results/chromium.json
distrobox enter wk -- ~/.bun/bin/bun probe5-motion/run.ts http://127.0.0.1:5190 webkit > probe5-motion/results/webkit.json
```

A third argument runs a subset, for example `q4,q5`.

## 1. `queueTask` alone (measured)

`handle.queueTask(fn)` without `handle.update()` does **not** run `fn`. It never schedules a flush.
The task stays parked on the component until something renders that component again. In the run,
nothing happened for 500 ms. The next unrelated `update()` on the same component then ran the parked
task, after its commit, with a live signal.

With `update()` the order is the same in both browsers, all inside one microtask after the click
handler returns:

| Step | Chromium (ms) | WebKit (ms) |
|---|---|---|
| click handler: `update()`, then `queueTask(fn)` | 777.5 | 818 |
| mixin `beforeUpdate` | 777.6 | 818 |
| render | 777.9 | 818 |
| mixin `commit` (DOM written) | 777.9 | 818 |
| `fn` runs, DOM already shows the new render | 777.9 | 818 |
| a microtask the handler queued after `update()` | 777.9 | 818 |
| the `update()` promise resolves | 777.9 | 818 |
| a `setTimeout(0)` the handler queued | 793 | 818 |

So the order is render, commit, task. The call order of `update()` and `queueTask()` inside the
handler does not matter. The docs' "good example" (a click handler that only calls `queueTask`) does
not run its task.

## 2. Shell persistence (measured)

The header node carried a JS marker (`WeakRef`) and a hand-set `data-mutated` attribute.

| Step | Header same node | Attribute kept | Shell setup runs | Shell renders (bar on) | Shell renders (bar off) |
|---|---|---|---|---|---|
| `/` to `/list` | yes | yes | 0 | 3 | 1 |
| `/list` to `/pane/1` | yes | yes | 0 | 3 | 1 |
| back to `/list` | yes | yes | 0 | 3 | 1 |
| back to `/` | yes | yes | 0 | 3 | n/a |

Shell setup ran once in the whole run. Same results in WebKit. The reconciler leaves attributes it does
not own. With the pending bar in the shell, every navigation renders the shell three times (bar on,
new route, bar off). Without it, once.

Route body state, `/pane/1` (3 taps) to `/pane/2`:

| | Taps after nav | Title same node | `PaneView` setup runs |
|---|---|---|---|
| no key | 3 (state leaks to pane 2) | yes | 0 |
| `key={url.pathname}` | 0 | no | 1 |

Same component type at the same position keeps its instance. Per-entity state needs a key.

## 3. Pending UI (measured)

The shell listens to `handle.frames.top` `reloadStart` and `reloadComplete`.

| | Chromium | WebKit |
|---|---|---|
| bar on / off, slow `/list` (300 ms) | 30 ms / 332 ms after observer start | 19 ms / 321 ms |
| bar width 150 ms into the nav (2 px high) | 170 px | 176 px |
| bar on / off, instant `/pane/1` | same millisecond (461/462) | same (451/452) |
| `frame.src` at `reloadStart` | new URL (`/list`) | new URL |
| `location` at `reloadStart` | already the new URL | already the new URL |

The bar shows for slow routes. For an instant route it toggles inside one task, so it never paints
(inferred). The URL commits before `reloadStart`, because the runtime intercepts with the Navigation API.

## 4. View transitions seam (measured)

Two seams were compared. Both start the transition in `reloadStart`.

- **naive**: the brief's seam, `startViewTransition(() => new Promise(r => top.addEventListener('reloadComplete', r, { once: true })))`.
- **gated**: listen for `reloadComplete` before starting, and have a router middleware await a promise
  that the update callback resolves. The route cannot commit until the old snapshot exists.

| Case | DOM at update callback (= old snapshot) | `ready` | Shared `pane-3` old+new pair | Chromium | WebKit |
|---|---|---|---|---|---|
| naive, link, slow `/list` | old route (correct) | ok | n/a | ok | ok |
| naive, link, instant `/list` to `/pane/3` | **new route (wrong)** | **TimeoutError after 4 s** | no | fails | fails |
| naive, `navigate()`, instant | **new route** | **TimeoutError after 4 s** | no | fails | fails |
| gated, link, slow | old route | ok | n/a | ok | ok |
| gated, link, instant (morph) | old route | ok after 49 ms (WebKit 99) | yes | ok | ok |
| gated, `navigate()`, instant (morph) | old route | ok | yes | ok | ok |
| gated, `history.back()` (morph back) | old route | ok | yes | ok | ok |

Why the naive seam fails: an instant route commits in microtasks. The browser takes the old snapshot
at the next frame, so it captures the new page. `reloadComplete` has already fired when the callback
adds its listener, so the promise never settles. Chromium then runs **no animation frame for the full
4 s** (first rAF 3.2 s after a probe started 0.8 s in), and `finished` never settles. WebKit kept
firing rAF (first frame after 15 ms) but also aborted after 4 s. No runtime error or console error in
either seam. `navigate()` behaves exactly like a link.

WebKit 26.5 supports `document.startViewTransition`. Its paused t=0 frame shows a correct old snapshot.
Its paused mid-flight frame did not show the moving title, so the WebKit morph is confirmed by the
pseudo-element pairs only, not visually (WPE software rendering in a container).

Side finding: every list row had a `view-transition-name`. That made 60 groups per capture, and in both
browsers the named rows below the scroller's clip were drawn outside it during the transition
(`results/q4-*-t0.jpg`). Name only the element that morphs.

## 5. Keyed reorder and transitions (measured)

30 rows, a 1000 ms `transform` transition started on each, a deterministic shuffle 300 ms in. The
reconciler keeps the longest increasing run in place and moves the rest with `insertBefore`.

| | Chromium | WebKit |
|---|---|---|
| rows moved / kept | 21 / 9 | 21 / 9 |
| moved rows: translateX before, right after the reorder (end value 40) | 11.3, **40** | 12, **40** |
| moved rows: `transitionend` / `transitioncancel` | 0 / 21 | 0 / 21 |
| kept rows: translateX before, after | 11.3, 11.3 | 12, 12.1 |
| kept rows: `transitionend` / `transitioncancel` | 9 / 0 | 9 / 0 |
| 10 rounds (flip every 500 ms, reorder 250 ms in): run / end / cancel | 300 / 19 / 281 | 300 / 13 / 287 |

A move cancels the running transition and the row snaps to its end value. Rows the diff does not move
keep animating.

Reorder every 500 ms, three rows followed every frame. "Step / distance" is the largest one-frame
step of a row divided by the layout distance it travelled. 1.0 means it jumped in one frame.

| Rows | Mode | Cost per reorder p50 / p95 ms, Chromium | WebKit | Step / distance |
|---|---|---|---|---|
| 30 | keyed, no animation | 0.3 / 0.6 | 1 / 1 | 1.00 |
| 30 | `animateLayout` (spring 600 ms) | 3.0 / 4.6 | 5 / 9 | 0.08 |
| 200 | keyed, no animation | 1.0 / 1.6 | 2 / 2 | 1.00 |
| 200 | `animateLayout` | **23.9 / 28.8** | **32 / 64** | 0.08 (WebKit 0.11) |

FLIP is smooth and survives interruption (each 600 ms spring is cut at 500 ms). It costs about 0.12 ms
per row in Chromium and 0.16 ms in WebKit, all inside the update. WebKit had 2 frames over 50 ms at 200
rows. Headless Chromium reported no long frames even for 24 ms tasks, so its frame numbers are not
trusted here.

## 6. Entrance and exit (measured)

`animateEntrance` / `animateExit` with `...spring(preset)`. A bottom sheet (`translateY(100%)`), a
toast (opacity + `translateY(8px)`), and keyed list rows (`animateExit` only). Removal time is a
MutationObserver stamp from the update that removed the node.

| Preset | Perceptual duration (docs) | `spring(p).duration` (settle) | Sheet removed after, C / W | Toast, C / W | Row, C / W |
|---|---|---|---|---|---|
| snappy | 200 ms | 350 ms | 384 / 352 | 383 / 352 | 365 / 351 |
| smooth | 400 ms | **1050 ms** | 1083 / 1059 | 1067 / 1060 | 1048 / 1062 |
| bouncy | 400 ms | 550 ms | 566 / 562 | 583 / 561 | 548 / 564 |

- The exit completes before removal. The node is still connected right after the commit, and the last
  frame before removal shows the end state (sheet at 240 px of 240, toast and row at opacity 0).
- Entrance animations ran for exactly `spring(p).duration` (350, 1050, 550).
- Exit time tracks the settle duration, not the preset's name. `smooth` holds a node for over 1 s.
- The exit uses the config from the **last render that showed the node**. A first run changed the
  preset without a render, and every row exit used the previous preset.
- Reclaim (row 3 removed, restored 60 ms later, `smooth`): the same DOM node comes back, one copy,
  order `1,2,3,4,5`. Opacity dipped to 0.79 (WebKit 0.85), never went lower, and was 0.996 at 700 ms.
  The reconciler re-inserted that node (one childList removal and one addition).

## 7. Imperative child (measured)

Three hosts, each filled with 100 rows by `ref` + `append`, under 60 parent re-renders (one per frame,
to stay under the cascade guard):

| Host | Rows after 60 renders | Same host node | Same first row node | Changing `data-count` attribute patched |
|---|---|---|---|---|
| no vdom children | 100 | yes | yes | yes (60) |
| no vdom children + `data-rmx-preserve-dom` | 100 | yes | yes | yes (60) |
| one vdom `<span>` + 100 imperative siblings | 100, span updated | yes | yes | n/a |

Same in WebKit. `data-rmx-preserve-dom` changes nothing on client renders; it even lets the attribute
patch through. The reconciler only touches nodes it created, so imperative siblings beside vdom
children also survive.

## 8. Inner scroll restoration (measured)

The list scrolls inside a 400 px `overflow: auto` box. Scroll so row 25 is at the top, go to
`/pane/1`, go back.

| | Back | Back again (after forward) | Fresh push to `/list` |
|---|---|---|---|
| runtime only | scrollTop 0, row 1 at top | 0 | 0 |
| module map + `queueTask` | **961, row 25 at top** | 961 | 0 |

Same in both browsers. The runtime restores only window scroll (the Navigation API). The idiom
(`pages.tsx`, about 15 lines): capture `navigation.currentEntry.key` in the list's setup, save
`scrollTop` on `scroll` into a module `Map` under that key, and in setup call
`handle.queueTask(() => scroller.scrollTop = saved)`. Keying by history entry instead of URL keeps a
fresh push to `/list` at the top.

## 9. Render cost of the no-bail-out rule (measured)

Shell + header clock + 200 row components on `/lab/cost`.

| Update | Row renders | Clock renders | Flush p50 / max, Chromium | WebKit |
|---|---|---|---|---|
| clock's own `handle.update()`, 20 ticks at 100 ms | **0** | 20 | 0.2 / 0.4 ms | 1 / 1 ms |
| shell `handle.update()`, 20 times | **4000 (200 each)** | 20 | 0.6 / 1.0 ms | 1 / 2 ms |

A component update re-renders that component and everything below it, even when its `children` prop is
the same object. Nothing above or beside it renders. Rows here are trivial, so 200 renders cost under
1 ms; real rows cost more.

## 10. Gesture mixins (measured)

`createMixin` long-press (500 ms, `setPointerCapture`, cancel on `pointerup`, `pointercancel`,
`pointerleave`, and a 10 px move tolerance) and a swipe mixin (`css({ touchAction: 'pan-y' })`,
velocity over the last 100 ms, 60 px or 0.5 px/ms threshold). Both dispatch `bubbles: true` events
(`app:longpress`, `app:swipe`, typed through `HTMLElementEventMap`). The parent consumes them with
`on('app:longpress', ...)`.

| Case | Chromium | WebKit |
|---|---|---|
| mouse hold 650 ms | 1 `app:longpress` at the parent, held 500 ms | same, 501 ms |
| mouse hold 300 ms | cancelled by `pointerup` | same |
| mouse drag 150 px out of the box while held | cancelled by the move tolerance; `pointerleave` only after release | same |
| synthetic `pointercancel` | cancelled by `pointercancel` | same |
| mouse swipe 180 px left in ~100 ms | `app:swipe` left, dx -180, vx -1.63 px/ms | same, vx -1.71 |
| slow 30 px drag | below threshold, no event | same |
| touch hold 650 ms (CDP) | 1 `app:longpress`, `pointerType=touch` | not run |
| touch swipe 180 px left (CDP) | `app:swipe` left, vx -0.60, no `pointercancel` | not run |
| touch drag 180 px up on the `pan-y` box (CDP) | browser scrolled 312 px, mixin got `pointercancel`, no swipe | not run |

With pointer capture, `pointerleave` cannot cancel a hold (it fires only after release). A long-press
needs its own move tolerance. Touch input through CDP is Chromium only, so WebKit ran the mouse cases only.

## Idioms the shell should adopt

1. **Keep the shell static; push state to leaves.** No bail-out exists: a shell update re-renders
   every route row (Q9), and a pending bar inside the shell costs two extra shell renders per
   navigation (Q2). Put the bar, the clock and any live badge in small components that subscribe on
   their own (`handle.frames.top` events, stores) and call their own `update()`. Key route bodies by
   entity (`key={pathname}` or the pane id) when instance state must not leak (Q2).
2. **Start view transitions in `reloadStart`, and gate the router on the update callback.** Never wait
   for `reloadComplete` inside the callback. Add the `reloadComplete` listener before
   `startViewTransition`, and let a first middleware await "old snapshot taken" (Q4). Give a
   `view-transition-name` only to the element that morphs.
3. **After-commit work is `update()` plus `queueTask()`, never `queueTask()` alone** (Q1). Restore inner
   scroll that way, from a module map keyed by `navigation.currentEntry.key` (Q8).
4. **Motion goes through `@remix-run/ui/animation`, not CSS transitions on reordered nodes.** Keyed
   moves cancel CSS transitions (Q5). Use `animateLayout` for lists up to about 30 to 50 rows and skip
   it for long lists (24 to 32 ms per reorder at 200 rows). Plan timings with `spring(p).duration`
   (snappy 350, bouncy 550, smooth 1050 ms), and render the exit config before the node goes (Q6).
   Gestures are `createMixin` plus a bubbling custom event, with pointer capture, a move tolerance and
   `touch-action: pan-y` (Q10).

## Surprises

- `queueTask` alone never runs, contrary to the docs' own example (Q1).
- The brief's view-transition seam breaks on every fast route: wrong old snapshot, a 4 s timeout,
  Chromium frozen for those 4 s, and a `finished` promise that never settles (Q4).
- Preset names hide the real duration: `smooth` keeps a node for 1.05 s (Q6).
- An exit animation uses the config from the previous render (Q6).
- Named elements inside an overflow box escape its clip during a view transition (Q4).
- `animateLayout` costs about 0.12 to 0.16 ms per row per reorder (Q5).
