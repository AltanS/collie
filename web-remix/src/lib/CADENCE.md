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
from `paneLoader` (`W/lib/loaders.ts:519`), here only `pollPane` does (`R/routes/pane/data.ts:51`).
The snapshot, the chat window and the config never feed it.

The beat and the renders are separate questions. Every read still runs on the beat above and still
reports to the cadence; what it WRITES is quiet: a store publishes only when the payload changed
(a 304, or a snapshot that differs only in `ts`, keeps the held object; `R/lib/same.ts`), and when
the bridge last answered is its own store, `snapshotAt` (`R/lib/data.ts`). So an unchanged poll
moves the cadence and the freshness readers, and renders nothing (REMIX3.md, "A module store is
right when").

## Screen × endpoint

| Screen | Endpoint | When | W/ | R/ |
| --- | --- | --- | --- | --- |
| every screen | `GET /api/snapshot` | each beat | `lib/loaders.ts:334` (root loader) | `lib/data.ts:121`, `shell.tsx:54` |
| every screen | `GET /api/config` | once per page; a failed read retries | `lib/operator-config.ts:31` | `lib/data.ts:153` (`shell.tsx:55` keeps it on the beat until one read lands) |
| pane | `GET /api/pane/:id?lines=600` | each beat, ETag / 304 | `lib/loaders.ts:508`, `lib/api.ts:455` | `routes/pane/pane.tsx:97`, `routes/pane/data.ts:47` (web's `fetchPane`) |
| pane, Chat gate open | `GET /api/pane/:id/chat` | each beat, after-cursor + ETag | `hooks/use-chat-window.ts:125`, `lib/api.ts:587` | `routes/pane/pane.tsx:376`, `routes/pane/chat-store.ts:76` (web's `fetchChat`) |
| home, Crew tab; machines | `GET /api/machines` | each beat while mounted | `lib/loaders.ts:650` | `routes/home/crew-tab.tsx:61`, `routes/machines/machines.tsx:30` |
| crew | `GET /api/crew` | each beat while mounted | `lib/loaders.ts:604` | `routes/crew/crew.tsx:64` |
| settings | `GET /api/devices`, update check | each beat while mounted | `lib/loaders.ts:568` | `routes/settings/paired-devices.tsx:52`, `routes/settings/updates.tsx:58` |
| home, Changes counts | `GET /api/changes` per space | own 5 s visible-only loop | `hooks/use-workspace-change-counts.ts:111` | `lib/change-counts.ts:151` |

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

Rows never move on a poll (REMIX3.md rule 8): the beat only writes stores, and lists keep their
frozen order until a tap.
