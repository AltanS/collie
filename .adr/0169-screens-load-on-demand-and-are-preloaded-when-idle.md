# 0169: Screens a first paint does not need load on demand, and are preloaded when the app is idle

- **Status:** Accepted (2026-11-21)
- **Date:** 2026-11-21
- **Trail:** The desktop pass of 2026-11-21. The main chunk stood at 3,128,881 bytes against the precache
  cap of 3,145,728 (`PRECACHE_MAX_FILE_BYTES`, `web/vite-icons.ts`) with five branches waiting to merge.
  An attribution of the chunk from its source map offered three cuts; the lead took the widest without
  Pair approve, and answered the held-reload case with an idle preload instead of a new look. Raising the
  cap was the other road, declined until the bytes were looked at. A counsel round on the same day added
  the reload ceiling, the preload's retries, the reload only for a failed fetch, the build guards and the
  measured cost. Files: `web/src/router.tsx`, `web/src/lib/lazy-route.ts`, `web/src/lib/route-preload.ts`,
  `web/src/lib/chunk-reload.ts`, `web/src/main.tsx`, `web/vite-bundle-guard.ts`.

## Context

The service worker precaches every file under `assets/`, and Workbox fails the build when one file is
above the cap, because an uncached main chunk breaks offline reading (M46). The chunk grew by about
1 MB between 1.24.1 and this record, with no wrong import in it: no test fixture, no playground, no
second copy of a library. The growth was the app itself (tricks, the Hill and agent views 376 kB, the
English catalog +75 kB, the Settings pages). Every screen sat in the one file a first paint loads.

A lazy chunk has one risk the main chunk does not. The new worker skips waiting, claims the tabs and
deletes every precache entry the new build does not name, and the bridge answers an old chunk name
with 404 (`serveStatic`). A tab still running the old build that asks for an old lazy chunk fails. It
reloads once onto the new build (`lib/chunk-reload.ts`), except while the reload is held (unsent text,
an upload, an open sheet, update mode); a held tab would show the error screen.

Where a service worker runs, offline is the precache's work: every lazy chunk is under `assets/`, so it
is in the manifest. The precache cannot help in two cases: a tab that outlives an update (the new worker
has dropped the old entries), and a page with no service worker (a plain-HTTP address, a browser that
refuses one). That is what the preload below is for.

## Decision

**The screens a first paint does not need are React Router `lazy` routes, and the app imports every
one of them in the background once it is idle, so an open tab holds them all as before.**

1. **What is lazy.** The whole `settings` tree (every section, Accounts, one trick, Change login, the
   index and Updates), Changes and Files (both addresses), New and Add your own, Crew, Machines and one
   Machine, Conversations and one conversation, History, the Hill and the Trick card. Eager: the
   Dashboard, a Space, a slot, a trick's session, the pane and its zoom, and Pair approve (the first-run
   path gets no new step).
2. **One line per route.** `lazy: lazyScreen(() => import("@/routes/x"), (m) => m.XRoute)`. Only the
   component is lazy; the loaders stay in the table, so data and code load in parallel.
3. **A navigation imports through `reloadOnChunkError`.** A missing chunk reloads once, as the language
   catalogs always did. When Vite's own `vite:preloadError` listener already started that reload, the
   route keeps the old screen while the page goes, for at most 10 s (`RELOAD_CEILING_MS`); then the
   route's error screen shows. A tab that holds its reload never waits: the listener does not cancel
   Vite's rethrow, and the error screen shows at once.
   **Only a chunk that could not be fetched reloads** (`isChunkFetchError`, each engine's words). Vite
   fires `vite:preloadError` also for a module's own top-level throw, which a reload would only repeat;
   that error goes to the route's error screen, through both doors.
4. **The idle preload.** After the first paint (`startRoutePreload` in `main.tsx`), when the browser is
   idle (`requestIdleCallback`, a 2 s timer where there is none), once per page load: every lazy chunk,
   one after another. A hidden document waits for `visibilitychange`, also between two chunks. A failed
   chunk is tried again, at most three rounds: offline on the `online` event and then the next idle
   moment, online on the next idle moment. With Save-Data on (`navigator.connection.saveData`) nothing is
   preloaded, and each screen loads when it is opened. The list is read from the route table, so a new
   lazy route needs no second list (`router-lazy.test.ts` fails for a lazy route the preload does not
   know).
5. **A preload never reloads.** It imports the bare chunk, and while one is in flight the
   `vite:preloadError` listener stands aside (Vite fires that event synchronously inside the failed
   import). A navigation in the same moment still reloads through `reloadOnChunkError`.
6. **A chunk that is not a route** uses `lazyChunk(() => import("./x"))` at module scope: the returned
   function imports through `reloadOnChunkError`, and the chunk joins the preload, also when its module
   is first evaluated during the preload. `lazy-imports.test.ts` fails for a dynamic import that is
   neither, unless it is an older door listed there by file and specifier, with its reason.
7. **A lazy screen cannot slide back unseen.** Rolldown's `INEFFECTIVE_DYNAMIC_IMPORT` fails the build,
   except for the modules listed with a reason in `web/vite-bundle-guard.ts` (one: the Settings layout,
   which the eager Pair approve reaches). The main chunk has a budget of 2,200,000 bytes; above it the
   build fails and names what to check first.
8. **Nothing else changes.** The cap stays at 3 MiB, and the service worker is not touched: every new
   chunk is under `assets/`, so it is in the precache manifest and opens offline.

## Consequences

- **The main chunk** went from 3,128,893 to 1,857,148 bytes (901,737 to 555,000 gzip). **The first
  paint** (the entry and every chunk it imports statically) went from 3,233,266 to 2,839,846 bytes
  (939,498 to 860,711 gzip), 21 files instead of 3: modules shared by the entry and a lazy chunk form
  chunks of their own, each with a `modulepreload` link. **The gain is room under the cap, not speed**:
  the first paint fell 12% in bytes.
- **The cost of the preload**, measured once in Playwright on the phone project with the CPU throttled 4x
  (CDP `Emulation.setCPUThrottlingRate`): 24 chunks, about 0.5 MB of JS (504,725 bytes decoded), in
  about 150 ms from about 0.8 s after the load, with no long task (50 ms or more). The two long tasks
  after the first paint (about 260 and 110 ms) are app start: they appear the same with the preload off.
  A tap during the preload had an input delay of 2 to 9 ms (Event Timing).
- **What a person sees** does not change. A tap on a lazy screen waits on the chunk with the old screen
  up and the mark turning, as a tap waits on a loader; from memory or the precache that is a few
  milliseconds. A cold deep link shows the boot screen a moment longer.
- **The window that is left.** A navigation to a lazy screen in the first seconds after a page load,
  before the preload has run, in a tab that holds its reload, right after an update swapped the build:
  that navigation shows the error screen, and its reload link. All four must meet; the lead accepted it.
- **Proof.** `e2e/lazy-screens.spec.ts` proves the page's memory, with the service worker blocked: after
  one online load and the preload, every lazy screen opens offline with no chunk fetched. It says
  nothing about the precache, which `service-worker.spec.ts` owns. `e2e/swap-lazy-screen.spec.ts`: a tab
  that held a draft through an update opens Settings, Appearance with no error screen.

## Considered, not done

- **The updater keeps the previous build's `assets/` for one update.** An old tab would then never get a
  404 for its own chunks, with or without a preload, and the held-tab window above would close. That is
  the root fix, and it belongs to the updater, after this record's release.
- **One chunk per idle callback.** Not needed at the measured cost; measure again before adding it.

## The cap's history

Main chunk `assets/index-*.js`, minified, not gzipped, against `PRECACHE_MAX_FILE_BYTES`:

| Build | Bytes | Note |
| --- | ---: | --- |
| 1.21.0 | 1,621,690 | |
| 1.23.x | 1,948,674 | |
| 1.24.1 (2026-10-25) | 2,101,583 | 1.5 kB over Workbox's 2 MiB default after one merge; the cap went to 3 MiB |
| stage/next, 2026-11-21 | 3,128,881 | 16.8 kB under 3 MiB; React Router already had its own chunk |
| after this record | 1,857,148 | the lazy screens out |
| stage/next, 2026-11-21, later | 1,871,350 | the budget of 2,200,000 starts here (`web/vite-bundle-guard.ts`) |

Before the cap or the budget is raised again, attribute the chunk from a source map (`vite build --sourcemap`) and
look at what grew; a screen that a first paint does not need goes behind `lazyScreen` first.
