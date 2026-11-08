# Collie tricks: the schema

Formerly mods, renamed to tricks 2026-11-08.

`schema.ts` is the contract between a trick and Collie. It holds every type a trick reads or writes,
the caps, the closed lists (tones, icons, places, node kinds), and one total parser per document.
It imports only `../json`, so the bridge, the CLI and the web all load it by relative path, with no
DOM and no `@/` alias. The design is the "Collie tricks" milestone in the tracker.

## The parsers

- `parseManifest(toml)`: `trick.toml` after the TOML parse. Later fields (`watch`, `on`, `serve`, a
  later place) are skipped with a `later` refusal, and the trick still loads.
- `parseFacts(json)`: a facts document, for `collie trick check --run` with fixture facts.
- `parseTrickDocumentText(stdout)` and `parseTrickDocument(json)`: the provider's output. A bad part
  is refused alone; `refusedParts` names it so the runner keeps its last good version, stale.
  `documentRefused` says no part was read at all.
- `parseTapRequest(json)`: the body of `POST /api/tricks/<host>/<id>/tap`.

None of them throws. Each refusal has a JSON pointer `path`, a `code` and a plain `reason`.

## Slice 01, the runner

Read stdout with `parseTrickDocumentText(text, { declared: manifest.places, afterTap })`. Pass
`kinds: CORE_NODE_KINDS` until slice 08 lands, so the phone never gets a kind it cannot draw.
Store each accepted part under `partKey({ host, trick, part })` with a rev, and send `TricksReply` and
`TrickTapReply`. `freshWindowMs` gives the window of a part with no `fresh`. `isScopeKey`,
`trickSessionId` and `matchesSession` cover facts, drafts and `view:<match>`.

## Slice 02, the renderer

Draw `ViewNode` by `kind`. The reserved heights are `text.lines`, `list.rows`, `table.rows` and
`log.lines`; `VIEW_LIMITS` holds the ranges. Ink comes from `TONE_TEXT_CLASS` only, and icons
from `TRICK_ICON_LUCIDE` only. A part past its fresh window draws as tone `unknown`.

## Slice 03, the two first places

`places.ts` takes the panes of `kind: "trick"` out of the snapshot's lists into
`HomeData.trickSessions`, so no count, triage or push path meets one. The root loader calls
`syncTricks(snap.tricksRev)`. A trick session id is `trick:<host>:<trick>:<part>`, with a colon because
a pane id is one path segment. `hooks/use-trick-handlers.ts` places a draft only in an empty box.

## Fixtures

`fixtures/index.ts` exports one document per place (`PLACE_DOCUMENTS`), one node per kind
(`NODE_FIXTURES`, `nodeDocument`), the two first tricks (`LEGS_DOCUMENT`, `TRACKER_DOCUMENT`), tap
replies, manifests, facts, and `REFUSED` with the exact refusal paths. `sessionPartOfBytes` and
`documentOfBytes` build documents of an exact size for cap tests.
