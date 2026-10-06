# Remix 3 spike: four probes

A go/no-go spike for moving Collie onto Remix 3 (`remix@3.0.0`, the non-React package).
Everything here is throwaway probe code. Nothing under `web/`, `bridge/` or `cli/` changed.
Measured 2026-10-06 on bluefin: Bun 1.4.1, Vite 8.3.1, Tailwind 4.3.3, Playwright 1.62.1
(Chromium 151, WebKit 26.5 WPE).

## Install finding: the 7-day gate blocks Remix

`remix@3.0.0` and all 48 `@remix-run/*` dependencies were published 2026-10-01. The checkout's
`bunfig.toml` (`minimumReleaseAge = 604800`) refuses them:

```
error: No version matching "remix" found for specifier "3.0.0" (blocked by minimum-release-age: 604800 seconds)
error: remix@3.0.0 failed to resolve
```

`spike/remix/bunfig.toml` keeps the 7-day gate and adds `minimumReleaseAgeExcludes` for exactly those
49 names. That works in Bun 1.4.1. It is for the spike only. The gate clears on its own on 2026-10-08.

## Run it

```sh
cd spike/remix
bun install
bun run test:server            # probe 1, no socket
bun run typecheck
bun run build:client           # probe 2 -> probe2-client/dist
bun run build:bench            # probe 3 -> probe3-screen/dist
STATIC_DIR=probe2-client/dist PORT=5193 bun probe1-server/server.ts &   # 127.0.0.1 only
STATIC_DIR=probe3-screen/dist PORT=5194 bun probe1-server/server.ts &
bun run nav > results/probe4-chromium.json     # probe 4, Chromium, with and without the Navigation API
bun run bench > results/probe3-chromium.json   # probe 3, Chromium
# WebKit needs libicu74, which Fedora lacks. Run it from the Ubuntu distrobox:
distrobox enter wk -- ~/.bun/bin/bun probe4-nav/nav.ts http://127.0.0.1:5193 webkit,webkit-nonav
distrobox enter wk -- ~/.bun/bin/bun probe3-screen/run.ts http://127.0.0.1:5194 webkit 10000
bun run table                  # prints the probe 3 tables from results/
```

Raw results are in `results/*.json`.

## Probe 1: server on Bun (`probe1-server/`)

`route()` + `createController()` + `createRouter()`, run by `Bun.serve({ fetch: (r) => router.fetch(r) })`
on 127.0.0.1. Two middlewares: security headers on every response (including static and 401), and a
bearer gate on the `/api` controller that answers `{ "error": { "code": "auth.required" } }` with 401.
JSON GET with ETag and 304, JSON POST, static files via `staticFiles()`, and a `/*path` route that
serves `index.html` for paths without an extension.

Result: everything imports and runs on Bun 1.4.1. 18 `bun test` cases pass through
`router.fetch(new Request(...))`. The real listener passed the same checks with curl (401 shape,
200 + ETag, 304, POST, SPA fallback, brotli asset, 404 for a missing file).

| Middleware | On Bun | Node built-ins it uses |
|---|---|---|
| `static` | works (ETag, 304, Range, traversal refused) | `node:fs`, `node:path` |
| `compression` | works (gzip, brotli, in front of static) | `node:zlib` |
| `logger` | works | none |
| `session` (cookie storage) | works | none |
| `session` (fs storage) | works | `node:fs`, `node:fs/promises` |
| `cors` | works (preflight, origin refused) | none |
| `form-data` | works | none |
| `async-context` | works (AsyncLocalStorage) | `node:async_hooks` |

No Node-only API was hit. The `remix` CLI (`#!/usr/bin/env node`) also runs under Bun (`remix doctor`).

Findings:

- `IfNoneMatch.matches()` from `remix/headers` is exact-match only. A client that sends `W/"tag"`
  misses, though RFC 9110 asks for weak comparison here. The probe checks both spellings.
- `createFileResponse` (used by `staticFiles`) honours `Range` only for non-compressible types by
  default. A JS file answers 200 to a Range request; a binary answers 206.
- A GET to a POST-only path (`GET /api/echo`) falls through to the less specific `/*path` route
  instead of a 405. A catch-all needs its own `/api` guard.
- A middleware that adds context (for example `logger()`) has a typed transform and does not fit a
  plain `Middleware[]` slot. Use `Middleware<any>[]` or inline arrays.
- The POST body is checked with `remix/data-schema` (`object`, `string`, `parseSafe`). It works on Bun
  and satisfies Collie's anti-slop lint rules, which refuse hand-written `typeof` narrowing.

## Probe 2: client shell with Vite (`probe2-client/`)

A client-only `remix/component` app built like `demos/spa`: Vite 8 with the JSX import source set to
`remix/component`, `remix/spa` `run(router)`, routes `/` (20 fake panes) and `/pane/:id` (the probe 3
screen over a real capture), Tailwind v4 via `@tailwindcss/vite`. The capture text is a lazy chunk per
pane, parsed with Collie's own `web/src/lib/ansi.ts` and `blocks.ts` (imported read-only; they import
only a React type).

Result: `vite build` writes one `index.html` plus hashed assets. Served by the probe 1 server, deep
links (`/pane/4`) and in-page navigation work in Chromium and WebKit with no console errors.

| Bundle (JS, minified) | Raw | Gzip |
|---|---|---|
| Remix entry chunk, all app code included | 142.3 kB | 45.7 kB |
| of which vendor (remix router, spa, component, route-pattern) | 129.9 kB | 41.1 kB |
| React 19.3 + React Router 7.18 baseline, vendor only, same two routes | 310.8 kB | 98.1 kB |
| Collie's real `web/dist` entry today, for scale | 1276 kB | 368 kB |

The baseline is `probe2-client/react-baseline/` (built, not run). App code is 5.6 to 8.7 kB in both.

Two integration findings:

- Collie's parser types its styles as React `CSSProperties`. Remix's `style` prop wants its own
  `StyleProps`, which has a string index signature, so `CSSProperties` and any `interface` are
  rejected. `shared/ansi-rows.ts` copies the six declarations the parser sets into a `type` alias.
- Collie's oxlint config carries React's `jsx-key` rule. Remix needs no keys, and positional diffing
  is a deliberate choice (the unkeyed bench variant). The spike builds such children in plain loops;
  a port would need the lint config to learn Remix's rules.

## Probe 3: screen redraw benchmark (`probe3-screen/`)

The capture is `omp--v18-4-approval-write-long.txt` (300 rows, 791 spans). A full replace swaps it for
`omp--v18-4-ask-multi.txt` (284 rows, 964 spans) every 2 s. Every other tick scrambles 4 cells. Viewport
390x844 at DPR 3, wrap on, 10 s per run. "Update" is `performance.now()` from before `handle.update()`
until its promise resolves (the imperative variant writes the DOM directly). Then a forced layout is
timed. Frames are `requestAnimationFrame` deltas. LoAF is `long-animation-frame` (Chromium only).
WebKit timers have 1 ms resolution. WebKit is WPE MiniBrowser with software rendering in a container,
so read its frame numbers as indicative only.

| Browser | CPU | Hz | Variant | Cell update p50 / p95 / max ms | Full replace p50 / max ms | Frames | Frames > 50 ms | LoAF > 50 ms | Guard fired |
|---|---|---|---|---|---|---|---|---|---|
| Chromium | 1x | 3 | unkeyed | 0.9 / 2.5 / 2.8 | 4.9 / 5.3 | 618 | 0 | 0 | 0 |
| Chromium | 1x | 3 | keyed | 0.8 / 1.2 / 2.3 | 3.7 / 3.9 | 618 | 0 | 0 | 0 |
| Chromium | 1x | 3 | imperative | 0.1 / 0.1 / 0.2 | 2.0 / 2.6 | 618 | 0 | 0 | 0 |
| Chromium | 1x | 10 | unkeyed | 0.5 / 0.9 / 2.0 | 4.0 / 4.8 | 599 | 0 | 0 | 0 |
| Chromium | 1x | 10 | keyed | 0.5 / 0.8 / 1.8 | 3.2 / 3.4 | 599 | 0 | 0 | 0 |
| Chromium | 1x | 10 | imperative | 0.0 / 0.1 / 0.2 | 1.5 / 1.5 | 599 | 0 | 0 | 0 |
| Chromium | 1x | 30 | unkeyed | 0.5 / 0.8 / 1.5 | 3.0 / 3.1 | 601 | 0 | 0 | 0 |
| Chromium | 1x | 30 | keyed | 0.6 / 0.9 / 2.0 | 3.1 / 3.6 | 601 | 0 | 0 | 0 |
| Chromium | 1x | 30 | imperative | 0.0 / 0.1 / 0.2 | 1.6 / 1.6 | 601 | 0 | 0 | 0 |
| Chromium | 4x | 30 | unkeyed | 1.8 / 3.1 / 7.7 | 11.8 / 13.2 | 598 | 0 | 0 | 0 |
| Chromium | 4x | 30 | keyed | 2.2 / 3.6 / 5.8 | 13.9 / 14.3 | 597 | 0 | 1 | 0 |
| Chromium | 4x | 30 | imperative | 0.1 / 0.8 / 1.4 | 8.6 / 9.2 | 597 | 0 | 0 | 0 |
| WebKit | 1x | 3 | unkeyed | 1 / 2 / 2 | 6 / 7 | 624 | 0 | n/a | 0 |
| WebKit | 1x | 3 | keyed | 1 / 2 / 2 | 6 / 12 | 614 | 0 | n/a | 0 |
| WebKit | 1x | 3 | imperative | 0 / 1 / 1 | 5 / 5 | 598 | 1 | n/a | 0 |
| WebKit | 1x | 10 | unkeyed | 2 / 3 / 5 | 7 / 12 | 592 | 1 | n/a | 0 |
| WebKit | 1x | 10 | keyed | 1 / 2 / 3 | 9 / 12 | 601 | 1 | n/a | 0 |
| WebKit | 1x | 10 | imperative | 0 / 0 / 0 | 4 / 5 | 602 | 3 | n/a | 0 |
| WebKit | 1x | 30 | unkeyed | 0 / 1 / 3 | 6 / 10 | 549 | 1 | n/a | 0 |
| WebKit | 1x | 30 | keyed | 1 / 2 / 8 | 7 / 15 | 556 | 2 | n/a | 0 |
| WebKit | 1x | 30 | imperative | 0 / 1 / 1 | 5 / 6 | 501 | 12 | n/a | 0 |

Every run ended with the DOM equal to the model. Two full runs agreed within about 1 ms. Keyed rows
cost the same as unkeyed here, because a full replace changes every row anyway. The WebKit long
frames sit in paint, not script: the imperative variant spends under 1 ms in script per tick.

### The cascade guard

The component scheduler counts flushes per component. It warns at 50 and drops the update after 50
"in one event loop turn". The counter resets only in a `setTimeout(0)`, so "one turn" really means
"until the next timer task runs".

| Burst of 60 updates | Guard warn / error (Chromium) | Guard warn / error (WebKit) | DOM = model 50 ms later |
|---|---|---|---|
| 60 sync `handle.update()` calls in one task | 0 / 0 | 0 / 0 | yes (batched to one flush) |
| 60 awaited `handle.update()` in one task | 1 / 1 | 1 / 1 | yes, but the 51st promise hangs |
| `ReadableStream` reader with 60 buffered chunks | 1 / 10 | 1 / 10 | **no**, last 10 updates dropped |
| 60 queued `MessageChannel` messages (how a WebSocket burst arrives) | 1 / 9 | 1 / 10 | **no**, last updates dropped |
| the same 60 messages, updates coalesced to one per `requestAnimationFrame` | 0 / 0 | 0 / 0 | yes |

The error text is `handle.update() infinite loop detected in <Component> after 51 cascading updates`.
A dropped update keeps its promise resolver queued, so it settles at the next successful render; the
component is not frozen for good. But the screen stays stale until something else calls
`handle.update()`. Collie must coalesce socket-driven updates per animation frame.

### `data-rmx-preserve-dom`

The attribute only changes frame reconciliation (server HTML reloads). On a client-only component it
does nothing. It is also not needed: an element rendered with no vdom children keeps imperatively
painted children through parent re-renders, with or without the attribute (300 rows before, 300 after
two re-renders, same node, in both browsers).

## Probe 4: WebKit navigation (`probe4-nav/`)

The probe 2 build behind the probe 1 server. A per-boot id tells an in-page navigation from a full
document load.

| Check | Chromium 151 | WebKit 26.5 | Chromium, Navigation API hidden | WebKit, Navigation API hidden |
|---|---|---|---|---|
| Runtime sees the Navigation API (`NavigateEvent.prototype.sourceElement`) | yes | yes | no | no |
| `/` to `/pane/3` by plain `<a>` stays in page | yes | yes | no, full load | no, full load |
| header link back to `/` stays in page | yes | yes | no, full load | no, full load |
| `history.back()` and `forward()` work | yes, in page | yes, in page | yes, full loads | yes, full loads |
| dispose + remount of the root (idle lock), router kept at module scope | works | works | works | works |
| navigation after remount stays in page, one router request per step | yes | yes | no, full load | no, full load |
| document loads in the whole script | 1 | 1 | 8 | 8 |
| console errors | 0 | 0 | 0 | 0 |

With the API hidden the runtime falls back to `location.assign()`, as the docs say. Every link is then a
full reload of the PWA: socket reconnect, auth, a refetch. Remount detail: `run()` renders into the whole
`document` top frame, so a lock screen needs `dispose()`, then its own `createRoot`, then `run()` again.
The shell remounts once per `run()` (setup count 2 over the script), and the route survives.

## Verdict

Conditional go for the client. The server works on Bun as is, but it gives Collie little that
`bridge/` lacks, so it is not a reason to move. The three biggest risks:

1. The cascade guard drops real updates under socket bursts. Mitigation is a per-frame coalescer
   in front of every stream-driven `handle.update()`. It must be a rule, not a habit.
2. In-page navigation depends on the Navigation API with `NavigateEvent.sourceElement`. Without it,
   every tap is a full reload. Check the oldest iOS Safari Collie supports on a real phone.
3. Remix 3.0.0 is five days old: 49 packages under the release-age gate, small API rough edges
   (weak ETag compare, 405 fall-through, typed middleware arrays), and no ecosystem for the
   shadcn/Radix pieces `web/` uses today.
