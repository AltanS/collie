# CADENCE.md: what this shell reads, on which screen, and how often

The rules are web's. This table mirrors `web/src` and gives the line in each app. `W/` is
`web/src/`, `R/` is `web-remix/src/`. Line numbers are as of commit "quiet polls, no forced layouts on
insert" (2026-10-07). If one side moves, fix this file in the same change.

## One beat, five rules

There is one beat for the whole app. Each screen registers the reads it renders (`want`,
REMIX3.md rule 4); web's one `revalidate()` re-runs the loaders of the routes that are mounted.

| Rule (first match wins) | Gap | W/ | R/ |
| --- | --- | --- | --- |
| A create or a close just went through (5 polls, any screen) | 300 ms | `hooks/use-polling.ts:106` | `lib/polling.ts:108` |
| A send just went to the open pane (5 polls, then 2 quiet ones) | 300 ms | `hooks/use-polling.ts:109`, `lib/poll-intent.ts:48` | `lib/polling.ts:108`, `lib/polling.ts:81` |
| Open pane, followed, its own agent working or blocked | 1.5 s | `hooks/use-polling.ts:115` | `lib/polling.ts:111` |
| Open pane, followed, its MIRROR read came back changed | 1.5 s | `hooks/use-polling.ts:116` | `lib/polling.ts:112` |
| An update run or a crew run is moving | 1.5 s | `hooks/use-polling.ts:128` | `lib/polling.ts:114` |
| No pane open, some agent working or blocked | 4 s | `hooks/use-polling.ts:132` | `lib/polling.ts:115` |
| Otherwise (an idle pane under a busy herd too) | 6 s | `hooks/use-polling.ts:135` | `lib/polling.ts:116` |

"Changed" is the pane mirror read's verdict, and nothing else's: web calls `markPollResult` only
from `paneLoader` (`W/lib/loaders.ts:519`), here only the mirror read does, whichever way it travels:
`pollPane` on the JSON path (`R/routes/pane/data.ts:51`), `pollPaneFrames` on the frames path
(`R/routes/pane/pane-frames.ts:284` for a 304, `:293` for a 200). A frame's own first load
(`resolvePaneFrame`) and the dashboard's prefetch never feed it. The snapshot, the chat window and
the config never do either.

The beat and the renders are separate questions. Every read still runs on the beat above and still
reports to the cadence; what it WRITES is quiet: a store publishes only when the payload changed
(a 304, or a snapshot that differs only in `ts`, keeps the held object; `R/lib/same.ts`), and when
the bridge last answered is its own store, `snapshotAt` (`R/lib/data.ts`). So an unchanged poll
moves the cadence and the freshness readers, and renders nothing (REMIX3.md, "A module store is
right when").

## Screen × endpoint

The "How" column says how this shell reads it. Every row but the pane's mirror is a JSON `fetch`
into a module store, as web's loaders do. Since S2 the pane's mirror can be two server frames
instead (REMIX3.md, "Frames"), off by default (the round 8 verdict: 1.6x the JSON read's bytes);
`?frames=1` turns them on for a device. Either way the WHEN is unchanged, only the HOW differs.

| Screen | Endpoint | When | How (R/) | W/ | R/ |
| --- | --- | --- | --- | --- | --- |
| every screen | `GET /api/snapshot` | each beat | JSON into a store | `lib/loaders.ts:334` (root loader) | `lib/data.ts:121`, `shell.tsx:54` |
| every screen | `GET /api/config` | once per page; a failed read retries | JSON into a store | `lib/operator-config.ts:31` | `lib/data.ts:153` (`shell.tsx:55` keeps it on the beat until one read lands) |
| pane, frames on (`?frames=1`) | `GET /pane/:id?lines=600&agent=…` with `X-Remix-Frame`, `X-Remix-Target`, `X-Collie-Poll` | each beat, the read's ETag / 304 | one poll answer: the read JSON and both frames' rows. 304: nothing at all. 200: the read into the store, then `frame.reload()` on each mounted frame whose rows moved; the runtime diffs them in by `data-rmx-key` | `lib/loaders.ts:508`, `lib/api.ts:455` | `routes/pane/pane.tsx:125`, `routes/pane/pane-frames.ts:254` |
| pane, frames off (the default) or latched | `GET /api/pane/:id?lines=600` | each beat, ETag / 304 | JSON into a store; the browser draws the rows | `lib/loaders.ts:508`, `lib/api.ts:455` | `routes/pane/pane.tsx:125`, `routes/pane/data.ts:47` (web's `fetchPane`) |
| pane, Chat gate open | `GET /api/pane/:id/chat` | each beat, after-cursor + ETag | JSON into a store (with frames on, the beat's poll answer then carries the status band only) | `hooks/use-chat-window.ts:125`, `lib/api.ts:587` | `routes/pane/pane.tsx:455`, `routes/pane/chat-store.ts:76` (web's `fetchChat`) |
| home, Crew tab; machines | `GET /api/machines` | each beat while mounted | JSON into a store | `lib/loaders.ts:650` | `routes/home/crew-tab.tsx:61`, `routes/machines/machines.tsx:30` |
| crew | `GET /api/crew` | each beat while mounted | JSON into a store | `lib/loaders.ts:604` | `routes/crew/crew.tsx:64` |
| settings | `GET /api/devices`, update check | each beat while mounted | JSON into a store | `lib/loaders.ts:568` | `routes/settings/paired-devices.tsx:52`, `routes/settings/updates.tsx:58` |
| home, Changes counts | `GET /api/changes` per space | own 5 s visible-only loop | JSON into a store | `hooks/use-workspace-change-counts.ts:111` | `lib/change-counts.ts:151` |

With frames on, the pane still makes ONE request per beat, as the JSON read did: the poll answer
carries the read (the card, the composer, the dialog guard's baseline still need the text) and both
frames. It is conditional only when every frame on screen is held, so a 304 never leaves one empty.
While the reader is scrolled up, the screen frame is not reloaded (the rows stay put, rule 8); the
held rows catch up at once on the jump back, with no request.

The snapshot carries no ETag on the bridge today, so neither app sends `If-None-Match` for it. This
shell would send one if the bridge ever adds it (`R/lib/api.ts:115`).

## Pauses and wake-ups

| Moment | Does | W/ | R/ |
| --- | --- | --- | --- |
| `document.hidden` | the beat fetches nothing | `hooks/use-polling.ts:246` | `lib/polling.ts:160` |
| idle lock up | the beat fetches nothing | `hooks/use-polling.ts:251` | `lib/polling.ts:160` |
| a long upload on the wire | the beat skips | `hooks/use-polling.ts:256` | `lib/polling.ts:160` |
| page visible again | "look now" (`POST /api/refresh`, lead only) and one read at once | `hooks/use-polling.ts:277` | `lib/polling.ts:248` |
| idle lock released | "look now" and one read, cover held through it | `hooks/use-polling.ts:228` | `lib/polling.ts:243` |
| `focus`, `online` | one read at once, no "look now" | `hooks/use-polling.ts:286` | `lib/polling.ts:253` |
| a read stuck 12 s | superseded | `hooks/use-polling.ts:273` | `lib/polling.ts:165` |
| a GET rejects with a browser network blip (`Load failed`, `Failed to fetch`, `NetworkError when attempting to fetch resource.`) | one immediate retry of the same GET; an outage fails the retry too and the poll reports it as before (web: none) | none | `lib/retry-get.ts`, `lib/api.ts` `get` (the snapshot, config and `bridgeGet` reads; the pane mirror read is web's `fetchPane` and is not covered) |

Rows never move on a poll (REMIX3.md rule 8): the beat only writes stores, and lists keep their
frozen order until a tap.
