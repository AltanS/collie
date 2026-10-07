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
instead (REMIX3.md, "Frames"), on by default (1.2x to 1.4x the JSON read's bytes after gzip in the
Terminal view, under 0.5x in Chat; `?frames=0` turns them off for a device). Either way the WHEN is unchanged, only the HOW differs.

| Screen | Endpoint | When | How (R/) | W/ | R/ |
| --- | --- | --- | --- | --- | --- |
| every screen of the static shell | `GET /api/snapshot` | each beat | JSON into a store | `lib/loaders.ts:334` (root loader) | `lib/data.ts:121`, `shell.tsx:54` |
| `home-list`: home and pane on an islands document (S3, the default) | `GET` of the page's own URL with `X-Remix-Frame`, `X-Remix-Target`, `X-Collie-Snap` (the hash each snapshot frame shows) and `X-Collie-Ranks` (the rows' frozen order) | each beat, in place of `/api/snapshot` | one answer: the snapshot's JSON, then the HTML of each snapshot frame (`home-list` on home, `pane-head` on a pane) whose hash moved. The snapshot goes into the same store; a moved frame is held and `frame.reload()` takes it, with no second request. An unmoved frame sends no HTML. A page whose answer is not ours falls back to `/api/snapshot` for the rest of its life | `lib/loaders.ts:334` | `islands/snapshot-frames.ts:137`, `islands/live.tsx:69`, `bridge/http/controllers/document.ts:233` |
| every screen | `GET /api/config` | once per page; a failed read retries | JSON into a store | `lib/operator-config.ts:31` | `lib/data.ts:153` (`shell.tsx:55` keeps it on the beat until one read lands) |
| pane, frames on (the default) | `GET /pane/:id?lines=600&agent=…` with `X-Remix-Frame`, `X-Remix-Target`, `X-Collie-Poll` (+ `text` while Find is open, `X-Collie-Reply` while a reply card is placed) | each beat, the read's ETag / 304 | one poll answer: the read without its text, carrying the screen model, and both frames' rows. 304: nothing at all. 200: the read into the store, then `frame.reload()` on each mounted frame whose rows moved; the runtime diffs them in by `data-rmx-key` | `lib/loaders.ts:508`, `lib/api.ts:455` | `routes/pane/pane.tsx:125`, `routes/pane/pane-frames.ts:254` |
| pane, frames off (`?frames=0`) or latched | `GET /api/pane/:id?lines=600` | each beat, ETag / 304 | JSON into a store; the browser draws the rows | `lib/loaders.ts:508`, `lib/api.ts:455` | `routes/pane/pane.tsx:125`, `routes/pane/data.ts:47` (web's `fetchPane`) |
| pane, Chat gate open | `GET /api/pane/:id/chat` | each beat, after-cursor + ETag | JSON into a store (with frames on, the beat's poll answer then carries the status band only) | `hooks/use-chat-window.ts:125`, `lib/api.ts:587` | `routes/pane/pane.tsx:455`, `routes/pane/chat-store.ts:76` (web's `fetchChat`) |
| home, Crew tab; machines | `GET /api/machines` | each beat while mounted | JSON into a store | `lib/loaders.ts:650` | `routes/home/crew-tab.tsx:61`, `routes/machines/machines.tsx:30` |
| crew | `GET /api/crew` | each beat while mounted | JSON into a store | `lib/loaders.ts:604` | `routes/crew/crew.tsx:64` |
| settings | `GET /api/devices`, update check | each beat while mounted | JSON into a store | `lib/loaders.ts:568` | `routes/settings/paired-devices.tsx:52`, `routes/settings/updates.tsx:58` |
| home, Changes counts | `GET /api/changes` per space | own 5 s visible-only loop | JSON into a store | `hooks/use-workspace-change-counts.ts:111` | `lib/change-counts.ts:151` |

With frames on, the pane still makes ONE request per beat, as the JSON read did: the poll answer
carries the read and both frames. The read has no text, since the rows are the same text drawn: it
carries the screen model (the dialog's blocks, the draft, the footer, counts), which the card, the
composer and the dialog guard's inputs are derived from, and the text itself only while Find is open. It is conditional only when every frame on screen is held, so a 304 never leaves one empty.
While the reader is scrolled up, the screen frame is not reloaded (the rows stay put, rule 8); the
held rows catch up at once on the jump back, with no request.

On an islands page the snapshot beat is still ONE request per beat at the same cadence: the page URL
replaces `/api/snapshot`, it does not add to it. The rows keep their frozen order because the beat
sends that order (`X-Collie-Ranks`) and the bridge draws `home-list` in it (rule 8).

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
